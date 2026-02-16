#!/usr/bin/env python3
"""
ioBroker RAG CLI Query Tool
Quick testing from the command line.
"""

import sys
import json
import time
from pathlib import Path

import chromadb
from sentence_transformers import SentenceTransformer

BASE_DIR = Path(__file__).parent
CHROMA_DIR = BASE_DIR / "data" / "chroma"
COLLECTION_NAME = "iobroker_docs"
EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2"


def query(question: str, top_k: int = 5, language: str = None):
    """Query the vector store and print results."""
    print(f"🔍 Query: {question}")
    print(f"   top_k={top_k}, language={language or 'any'}")
    print("=" * 70)

    # Load model
    t0 = time.time()
    model = SentenceTransformer(EMBEDDING_MODEL)
    print(f"   Model loaded in {time.time()-t0:.1f}s")

    # Connect to ChromaDB
    client = chromadb.PersistentClient(path=str(CHROMA_DIR))
    collection = client.get_collection(name=COLLECTION_NAME)
    print(f"   Collection: {collection.count()} documents")

    # Embed query
    t1 = time.time()
    query_embedding = model.encode(question).tolist()

    # Build filter
    where = {"language": language} if language else None

    # Search
    results = collection.query(
        query_embeddings=[query_embedding],
        n_results=top_k,
        where=where,
        include=["documents", "metadatas", "distances"],
    )

    query_time = (time.time() - t1) * 1000
    print(f"   Query time: {query_time:.0f}ms\n")

    if not results["documents"][0]:
        print("   ❌ No results found.")
        return

    for i, (doc, meta, dist) in enumerate(zip(
        results["documents"][0],
        results["metadatas"][0],
        results["distances"][0],
    )):
        relevance = max(0, 1 - dist)
        print(f"── Result {i+1} ─ relevance: {relevance:.3f} ──")
        print(f"   📄 {meta.get('source', '?')}")
        print(f"   Type: {meta.get('type', '?')} | Lang: {meta.get('language', '?')} | Adapter: {meta.get('adapter_name', '?')}")
        if meta.get("section"):
            print(f"   Section: {meta['section']}")
        # Show first 300 chars of content
        preview = doc[:300].replace("\n", "\n   ")
        print(f"   {preview}")
        if len(doc) > 300:
            print(f"   ... ({len(doc)} chars total)")
        print()

    return results


if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("Usage: python query.py 'your question' [top_k] [language]")
        print("Example: python query.py 'How do I subscribe to state changes?' 5 en")
        sys.exit(1)

    q = sys.argv[1]
    k = int(sys.argv[2]) if len(sys.argv) > 2 else 5
    lang = sys.argv[3] if len(sys.argv) > 3 else None

    query(q, k, lang)
