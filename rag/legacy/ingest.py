#!/usr/bin/env python3
"""
ioBroker RAG Ingestion Pipeline
Reads markdown, JS, and TS files from cloned repos, chunks them intelligently,
and stores embeddings in ChromaDB.
"""

import os
import re
import hashlib
import logging
import time
from pathlib import Path
from typing import Optional

import tiktoken
import chromadb
from sentence_transformers import SentenceTransformer

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

# ── Config ──────────────────────────────────────────────────────────────────
BASE_DIR = Path(__file__).parent
REPOS_DIR = BASE_DIR / "data" / "repos"
CHROMA_DIR = BASE_DIR / "data" / "chroma"
COLLECTION_NAME = "iobroker_docs"
EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2"
CHUNK_SIZE = 512       # tokens
CHUNK_OVERLAP = 50     # tokens

# Which paths to index from each repo
REPO_PATHS = {
    "ioBroker.docs": [
        "docs/en/dev",
        "docs/en/basics",
        "docs/de/dev",
        "docs/de/basics",
        "docs/en/admin",
        "docs/de/admin",
    ],
    "ioBroker.template": ["."],
    "create-adapter": ["src", "templates", "README.md"],
    "ioBroker.js-controller": ["lib", "doc", "README.md", "packages"],
    "ioBroker.javascript": ["lib", "docs", "README.md"],
    "ioBroker.simple-api": ["lib", "README.md"],
}

# File extensions to process
EXTENSIONS = {".md", ".js", ".ts", ".jsx", ".tsx", ".json"}
# Skip patterns
SKIP_PATTERNS = {"node_modules", ".git", "dist", "build", "__pycache__", ".nyc_output", "test", "tests"}


def detect_file_type(filepath: str) -> str:
    """Classify a file as doc, code, or api based on path and extension."""
    ext = Path(filepath).suffix.lower()
    path_lower = filepath.lower()

    if ext == ".md":
        if "api" in path_lower or "reference" in path_lower:
            return "api"
        return "doc"
    if ext in {".js", ".ts", ".jsx", ".tsx"}:
        if "adapter" in path_lower or "lib" in path_lower:
            return "api"
        return "code"
    if ext == ".json":
        return "config"
    return "doc"


def detect_language(filepath: str) -> str:
    """Detect content language from file path."""
    if "/de/" in filepath or "\\de\\" in filepath:
        return "de"
    return "en"


def detect_adapter_name(filepath: str) -> str:
    """Extract adapter name from file path."""
    parts = filepath.replace("\\", "/").split("/")
    for part in parts:
        if part.startswith("ioBroker."):
            return part
        if part == "create-adapter":
            return part
    return "iobroker-core"


class SmartChunker:
    """Token-aware chunker that respects code blocks and section boundaries."""

    def __init__(self, max_tokens: int = CHUNK_SIZE, overlap_tokens: int = CHUNK_OVERLAP):
        self.max_tokens = max_tokens
        self.overlap_tokens = overlap_tokens
        self.tokenizer = tiktoken.get_encoding("cl100k_base")

    def count_tokens(self, text: str) -> int:
        return len(self.tokenizer.encode(text, disallowed_special=()))

    def chunk_markdown(self, text: str, source_file: str) -> list[dict]:
        """Chunk markdown with awareness of headers and code blocks."""
        chunks = []
        # Split by code blocks first
        parts = re.split(r'(```[\s\S]*?```)', text)

        current_chunk = ""
        current_section = ""

        for part in parts:
            # If it's a code block, treat it as its own chunk(s)
            if part.startswith("```") and part.endswith("```"):
                # Flush current text chunk
                if current_chunk.strip():
                    chunks.extend(self._split_by_tokens(
                        current_chunk.strip(), source_file, "doc", current_section
                    ))
                    current_chunk = ""
                # Add code block as its own chunk(s)
                chunks.extend(self._split_by_tokens(
                    part.strip(), source_file, "code", current_section
                ))
            else:
                # Track section headers
                for line in part.split("\n"):
                    header_match = re.match(r'^(#{1,3})\s+(.+)', line)
                    if header_match:
                        current_section = header_match.group(2).strip()
                current_chunk += part

                # If accumulated chunk is getting large, flush
                if self.count_tokens(current_chunk) > self.max_tokens:
                    chunks.extend(self._split_by_tokens(
                        current_chunk.strip(), source_file, "doc", current_section
                    ))
                    current_chunk = ""

        # Flush remaining
        if current_chunk.strip():
            chunks.extend(self._split_by_tokens(
                current_chunk.strip(), source_file, "doc", current_section
            ))

        return chunks

    def chunk_code(self, text: str, source_file: str) -> list[dict]:
        """Chunk code files, trying to split at function/class boundaries."""
        chunks = []
        # Try splitting at function/class definitions
        # For JS/TS: function, class, const/let/var with arrow functions, exports
        boundaries = re.split(
            r'(?=\n(?:export\s+)?(?:async\s+)?(?:function|class|const|let|var)\s+\w+)',
            text
        )

        current_chunk = ""
        for block in boundaries:
            if self.count_tokens(current_chunk + block) > self.max_tokens and current_chunk.strip():
                chunks.extend(self._split_by_tokens(
                    current_chunk.strip(), source_file, "code", ""
                ))
                current_chunk = block
            else:
                current_chunk += block

        if current_chunk.strip():
            chunks.extend(self._split_by_tokens(
                current_chunk.strip(), source_file, "code", ""
            ))

        return chunks

    def _split_by_tokens(self, text: str, source_file: str, chunk_type: str, section: str) -> list[dict]:
        """Final token-based splitting with overlap."""
        if not text.strip():
            return []

        tokens = self.tokenizer.encode(text, disallowed_special=())
        if len(tokens) <= self.max_tokens:
            return [{
                "text": text,
                "source_file": source_file,
                "type": chunk_type,
                "section": section,
                "token_count": len(tokens),
            }]

        chunks = []
        start = 0
        while start < len(tokens):
            end = min(start + self.max_tokens, len(tokens))
            chunk_tokens = tokens[start:end]
            chunk_text = self.tokenizer.decode(chunk_tokens)

            chunks.append({
                "text": chunk_text,
                "source_file": source_file,
                "type": chunk_type,
                "section": section,
                "token_count": len(chunk_tokens),
            })

            if end >= len(tokens):
                break
            start = end - self.overlap_tokens

        return chunks


def collect_files() -> list[tuple[str, str]]:
    """Collect all relevant files from repos. Returns (abs_path, relative_display_path)."""
    files = []

    for repo_name, paths in REPO_PATHS.items():
        repo_dir = REPOS_DIR / repo_name
        if not repo_dir.exists():
            logger.warning(f"Repo not found: {repo_dir}")
            continue

        for rel_path in paths:
            target = repo_dir / rel_path
            if target.is_file():
                if target.suffix.lower() in EXTENSIONS:
                    display = f"{repo_name}/{rel_path}"
                    files.append((str(target), display))
            elif target.is_dir():
                for root, dirs, filenames in os.walk(target):
                    # Skip unwanted directories
                    dirs[:] = [d for d in dirs if d not in SKIP_PATTERNS]
                    for fname in filenames:
                        fpath = Path(root) / fname
                        if fpath.suffix.lower() in EXTENSIONS:
                            rel = fpath.relative_to(repo_dir)
                            display = f"{repo_name}/{rel}"
                            files.append((str(fpath), display))

    return files


def make_doc_id(source: str, chunk_idx: int) -> str:
    """Create a deterministic document ID."""
    h = hashlib.md5(f"{source}:{chunk_idx}".encode()).hexdigest()[:12]
    return f"{h}_{chunk_idx}"


def ingest(reset: bool = False):
    """Main ingestion pipeline."""
    start_time = time.time()

    # ── Init embedding model ──────────────────────────────────────────
    logger.info(f"Loading embedding model: {EMBEDDING_MODEL}")
    model = SentenceTransformer(EMBEDDING_MODEL)
    logger.info("Model loaded.")

    # ── Init ChromaDB ─────────────────────────────────────────────────
    logger.info(f"ChromaDB path: {CHROMA_DIR}")
    client = chromadb.PersistentClient(path=str(CHROMA_DIR))

    if reset:
        try:
            client.delete_collection(COLLECTION_NAME)
            logger.info(f"Deleted existing collection: {COLLECTION_NAME}")
        except Exception:
            pass

    collection = client.get_or_create_collection(
        name=COLLECTION_NAME,
        metadata={"hnsw:space": "cosine"}
    )
    existing_count = collection.count()
    logger.info(f"Collection '{COLLECTION_NAME}' has {existing_count} existing documents")

    # ── Collect files ─────────────────────────────────────────────────
    files = collect_files()
    logger.info(f"Found {len(files)} files to process")

    # ── Chunk everything ──────────────────────────────────────────────
    chunker = SmartChunker()
    all_chunks = []

    for filepath, display_path in files:
        try:
            with open(filepath, "r", encoding="utf-8", errors="ignore") as f:
                content = f.read()

            if not content.strip():
                continue

            ext = Path(filepath).suffix.lower()
            if ext == ".md":
                chunks = chunker.chunk_markdown(content, display_path)
            else:
                chunks = chunker.chunk_code(content, display_path)

            # Add metadata
            for chunk in chunks:
                chunk["language"] = detect_language(display_path)
                chunk["adapter_name"] = detect_adapter_name(display_path)
                if chunk["type"] == "doc" and ext != ".md":
                    chunk["type"] = detect_file_type(display_path)

            all_chunks.extend(chunks)
        except Exception as e:
            logger.warning(f"Error processing {display_path}: {e}")

    logger.info(f"Created {len(all_chunks)} chunks from {len(files)} files")

    if not all_chunks:
        logger.error("No chunks created! Check repo paths.")
        return

    # ── Stats ─────────────────────────────────────────────────────────
    type_counts = {}
    lang_counts = {}
    for c in all_chunks:
        type_counts[c["type"]] = type_counts.get(c["type"], 0) + 1
        lang_counts[c["language"]] = lang_counts.get(c["language"], 0) + 1

    logger.info(f"Chunk types: {type_counts}")
    logger.info(f"Languages: {lang_counts}")

    # ── Embed and store ───────────────────────────────────────────────
    BATCH_SIZE = 64
    total_stored = 0

    for i in range(0, len(all_chunks), BATCH_SIZE):
        batch = all_chunks[i:i + BATCH_SIZE]
        texts = [c["text"] for c in batch]
        ids = [make_doc_id(c["source_file"], i + j) for j, c in enumerate(batch)]
        metadatas = [{
            "source": c["source_file"],
            "type": c["type"],
            "language": c["language"],
            "adapter_name": c["adapter_name"],
            "section": c.get("section", ""),
            "token_count": c["token_count"],
        } for c in batch]

        # Generate embeddings
        embeddings = model.encode(texts, show_progress_bar=False).tolist()

        # Upsert into ChromaDB
        collection.upsert(
            ids=ids,
            embeddings=embeddings,
            documents=texts,
            metadatas=metadatas,
        )

        total_stored += len(batch)
        if total_stored % 256 == 0 or total_stored == len(all_chunks):
            logger.info(f"Stored {total_stored}/{len(all_chunks)} chunks")

    elapsed = time.time() - start_time
    final_count = collection.count()
    logger.info(f"Ingestion complete! {final_count} total documents in collection.")
    logger.info(f"Time elapsed: {elapsed:.1f}s")

    # Save stats
    stats = {
        "files_processed": len(files),
        "chunks_created": len(all_chunks),
        "total_in_collection": final_count,
        "type_distribution": type_counts,
        "language_distribution": lang_counts,
        "elapsed_seconds": round(elapsed, 1),
    }
    import json
    stats_path = BASE_DIR / "data" / "ingest_stats.json"
    with open(stats_path, "w") as f:
        json.dump(stats, f, indent=2)
    logger.info(f"Stats saved to {stats_path}")

    return stats


if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Ingest ioBroker docs into ChromaDB")
    parser.add_argument("--reset", action="store_true", help="Delete existing collection first")
    args = parser.parse_args()
    ingest(reset=args.reset)
