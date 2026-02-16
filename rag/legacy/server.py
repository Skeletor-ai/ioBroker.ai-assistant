#!/usr/bin/env python3
"""
ioBroker RAG REST API Server
FastAPI service providing semantic search over ioBroker documentation.
"""

import logging
import time
from pathlib import Path
from typing import Optional

import chromadb
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from sentence_transformers import SentenceTransformer

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger(__name__)

# ── Config ──────────────────────────────────────────────────────────────────
BASE_DIR = Path(__file__).parent
CHROMA_DIR = BASE_DIR / "data" / "chroma"
COLLECTION_NAME = "iobroker_docs"
EMBEDDING_MODEL = "sentence-transformers/all-MiniLM-L6-v2"

# ── Init ────────────────────────────────────────────────────────────────────
logger.info(f"Loading embedding model: {EMBEDDING_MODEL}")
model = SentenceTransformer(EMBEDDING_MODEL)
logger.info("Model loaded.")

logger.info(f"Connecting to ChromaDB at {CHROMA_DIR}")
chroma_client = chromadb.PersistentClient(path=str(CHROMA_DIR))
collection = chroma_client.get_collection(name=COLLECTION_NAME)
doc_count = collection.count()
logger.info(f"Collection '{COLLECTION_NAME}' loaded with {doc_count} documents")

# ── FastAPI App ─────────────────────────────────────────────────────────────
app = FastAPI(
    title="ioBroker RAG API",
    description="Semantic search over ioBroker documentation, adapter templates, and API references.",
    version="1.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Models ──────────────────────────────────────────────────────────────────
class QueryRequest(BaseModel):
    question: str = Field(..., description="The question to search for", min_length=1)
    top_k: int = Field(5, description="Number of results to return", ge=1, le=20)
    language: Optional[str] = Field(None, description="Filter by language (en/de)")
    doc_type: Optional[str] = Field(None, description="Filter by type (doc/code/api/config)")
    include_prompt: bool = Field(True, description="Include a pre-built prompt for LLM use")


class Source(BaseModel):
    file: str
    type: str
    language: str
    adapter: str
    section: str
    relevance: float


class QueryResponse(BaseModel):
    context: str
    sources: list[Source]
    prompt: Optional[str] = None
    query_time_ms: float
    total_results: int


class HealthResponse(BaseModel):
    status: str
    documents: int
    model: str
    collection: str


# ── Endpoints ───────────────────────────────────────────────────────────────
@app.get("/health", response_model=HealthResponse)
async def health():
    """Health check with collection stats."""
    return HealthResponse(
        status="ok",
        documents=collection.count(),
        model=EMBEDDING_MODEL,
        collection=COLLECTION_NAME,
    )


@app.post("/query", response_model=QueryResponse)
async def query(req: QueryRequest):
    """
    Query the ioBroker knowledge base.

    Returns relevant documentation chunks, source references,
    and optionally a pre-built prompt for LLM consumption.
    """
    start = time.time()

    # Build query embedding
    query_embedding = model.encode(req.question).tolist()

    # Build where filter
    where_filter = None
    conditions = []
    if req.language:
        conditions.append({"language": req.language})
    if req.doc_type:
        conditions.append({"type": req.doc_type})

    if len(conditions) == 1:
        where_filter = conditions[0]
    elif len(conditions) > 1:
        where_filter = {"$and": conditions}

    # Query ChromaDB
    try:
        results = collection.query(
            query_embeddings=[query_embedding],
            n_results=req.top_k,
            where=where_filter,
            include=["documents", "metadatas", "distances"],
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Query failed: {str(e)}")

    if not results["documents"] or not results["documents"][0]:
        return QueryResponse(
            context="No relevant documents found.",
            sources=[],
            prompt=None,
            query_time_ms=round((time.time() - start) * 1000, 1),
            total_results=0,
        )

    # Build response
    documents = results["documents"][0]
    metadatas = results["metadatas"][0]
    distances = results["distances"][0]

    # Build context string
    context_parts = []
    sources = []

    for i, (doc, meta, dist) in enumerate(zip(documents, metadatas, distances)):
        # ChromaDB cosine distance: 0 = identical, 2 = opposite
        relevance = max(0, 1 - dist)

        source = Source(
            file=meta.get("source", "unknown"),
            type=meta.get("type", "unknown"),
            language=meta.get("language", "en"),
            adapter=meta.get("adapter_name", "unknown"),
            section=meta.get("section", ""),
            relevance=round(relevance, 3),
        )
        sources.append(source)

        # Format context chunk
        header = f"[Source: {meta.get('source', 'unknown')}"
        if meta.get("section"):
            header += f" § {meta['section']}"
        header += f" | {meta.get('type', '?')} | relevance: {relevance:.2f}]"

        context_parts.append(f"{header}\n{doc}")

    context = "\n\n---\n\n".join(context_parts)

    # Build prompt if requested
    prompt = None
    if req.include_prompt:
        prompt = (
            f"Based on the following ioBroker documentation and code references:\n\n"
            f"{context}\n\n"
            f"---\n\n"
            f"Answer the following question accurately. "
            f"Reference specific files and code examples where applicable. "
            f"If the documentation doesn't fully cover the question, say so.\n\n"
            f"Question: {req.question}"
        )

    query_time = round((time.time() - start) * 1000, 1)

    return QueryResponse(
        context=context,
        sources=sources,
        prompt=prompt,
        query_time_ms=query_time,
        total_results=len(documents),
    )


@app.get("/stats")
async def stats():
    """Return collection statistics."""
    count = collection.count()
    # Sample some metadatas
    sample = collection.peek(limit=100)
    types = {}
    languages = {}
    adapters = {}

    if sample and sample.get("metadatas"):
        for m in sample["metadatas"]:
            t = m.get("type", "unknown")
            types[t] = types.get(t, 0) + 1
            l = m.get("language", "unknown")
            languages[l] = languages.get(l, 0) + 1
            a = m.get("adapter_name", "unknown")
            adapters[a] = adapters.get(a, 0) + 1

    return {
        "total_documents": count,
        "sample_type_distribution": types,
        "sample_language_distribution": languages,
        "sample_adapter_distribution": adapters,
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8321)
