import logging
from typing import Any, Dict, List, Tuple

import torch
import torch.nn.functional as F

from qdrant_client.models import ScoredPoint  # for search results
from src.vector_store.qdrant_config import QdrantManager
from src.util.get_agent_config import load_agent_config
from src.hugging_face_query import HuggingFaceQuery  # Adjust this import path as needed

logger = logging.getLogger(__name__)

class QueryModel(HuggingFaceQuery):
    """
    Query model that extends HuggingFaceQuery.
    Provides:
      - A method to embed queries (with "query:" prefix).
      - A QA-style search method (qa_search) that embeds the query and searches Qdrant.
      - A deep semantic search method (deep_semantic_search) that returns a short snippet plus score.
    """

    def __init__(self, model_name: str = None, device: str = None):
        super().__init__(model_name=model_name, device=device)

        # Load query-specific settings from config.
        config = load_agent_config()
        agent_cfg = config.get("agent", {})
        query_cfg = agent_cfg.get("query_model", {})

        # read other settings for the QueryModel
        self.max_length = query_cfg.get("max_tokens", 4096)
        self.top_k = query_cfg.get("top_k", 5)

        # Optionally define batch_size for queries (if you want)
        self.batch_size = query_cfg.get("batch_size", 8)
        self.device = query_cfg.get("device", "cpu")
        # You can store 'timeout' or other fields if needed
        self.timeout = query_cfg.get("timeout", 10)

        logger.info(
            f"Initialized QueryModel with model_name={self.model_name}, device={self.device}, "
            f"max_length={self.max_length}, top_k={self.top_k}, batch_size={self.batch_size}"
        )

    def average_pool(self, last_hidden_states: torch.Tensor, attention_mask: torch.Tensor) -> torch.Tensor:
        """
        Apply average pooling on the model's last hidden states using the attention mask.
        """
        masked_hidden = last_hidden_states.masked_fill(~attention_mask[..., None].bool(), 0.0)
        summed = masked_hidden.sum(dim=1)
        counts = attention_mask.sum(dim=1)
        return summed / counts.unsqueeze(1)

    def embed_query(self, queries: List[str]) -> List[List[float]]:
        """
        Embed a list of queries.
        Each query is prefixed with "query:" (if required by your model)
        and processed in batches. Returns a list of normalized embedding vectors.
        """
        prefixed_queries = [f"query: {q}" for q in queries]
        all_embeddings = []

        for start_idx in range(0, len(prefixed_queries), self.batch_size):
            batch_queries = prefixed_queries[start_idx : start_idx + self.batch_size]
            logger.debug(f"Embedding queries from index {start_idx} to {start_idx + len(batch_queries)-1}")

            encoding = self.tokenizer(
                batch_queries,
                padding=True,
                truncation=True,
                max_length=self.max_length,
                return_tensors="pt"
            )

            if "attention_mask" in encoding:
                encoding["attention_mask"] = encoding["attention_mask"].float()

            for key, tensor_val in encoding.items():
                encoding[key] = tensor_val.to(self.device)

            with torch.no_grad():
                outputs = self.model(**encoding, return_dict=True)
                embeddings = self.average_pool(outputs.last_hidden_state, encoding["attention_mask"])
                embeddings = F.normalize(embeddings, p=2, dim=1)

            all_embeddings.extend(embeddings.cpu().numpy().tolist())

        return all_embeddings

    def qa_search_with_hits(
        self, question: str, collection_name: str
    ) -> Tuple[List[str], List[Dict[str, Any]]]:
        """
        Richer variant of `qa_search` that returns BOTH the legacy text-only
        docs list AND a parallel `hits` list of per-point dicts with the full
        Qdrant metadata the upstream TypeScript agent needs to emit real
        `rag.retrieved` envelope frames (point id, cosine score, source file,
        per-document chunk index) without synthesizing any of it client-side.

        Added in Commit 5-prep (browser_agent Week 1B). The docs side is
        unchanged byte-for-byte: sentinel strings are preserved when the
        embedding fails or when Qdrant returns zero matches, so any caller
        using the docs-only wrapper below continues to observe the historical
        behavior. `hits` is `[]` in both sentinel cases.

        `docs` and `hits` are aligned index-by-index for real results: if a
        Qdrant point lacks the `text` payload key we drop it from both lists
        together so consumers can zip them without further bookkeeping.
        """
        query_vector = self.embed_query([question])[0]
        if not query_vector:
            logger.info("Failed to create embedding for the query.")
            return (["I'm sorry, I couldn't understand that question."], [])

        # For top_k, we can read from config again or just use self.top_k
        top_k = self.top_k

        manager = QdrantManager(collection_name)
        search_results = manager.search(query_vector, top_k=top_k)  # returns List[ScoredPoint]

        if not search_results:
            logger.info("No matches found in Qdrant for Q/A search.")
            return (["No relevant context found."], [])

        docs: List[str] = []
        hits: List[Dict[str, Any]] = []
        for i, point in enumerate(search_results):
            payload = point.payload or {}
            if "text" not in payload:
                continue
            text = payload["text"]
            logger.debug(f"Document {i + 1} text: {text}")
            docs.append(text)
            hits.append({
                "id": str(point.id),
                "score": float(point.score) if point.score is not None else 0.0,
                "text": text,
                "source": payload.get("source_file"),
                "chunk_id": payload.get("chunk_id"),
            })

        return (docs, hits)

    def qa_search(self, question: str, collection_name: str) -> List[str]:
        """
        1. Embed the user query.
        2. Search Qdrant for documents similar to the query in vector space.
        3. Optionally pass the question plus retrieved docs to a QA model (not shown).
        4. Return the retrieved document texts.

        Thin back-compat wrapper around `qa_search_with_hits` — preserves the
        pre-Commit-5 `List[str]` return contract for in-repo callers like
        `configurator.py` that only want the document text.
        """
        docs, _ = self.qa_search_with_hits(question, collection_name)
        return docs

    def deep_semantic_search_with_hits(
        self, query: str, collection_name: str
    ) -> Tuple[List[str], List[Dict[str, Any]]]:
        """
        Richer variant of `deep_semantic_search` mirroring `qa_search_with_hits`.
        The docs side keeps the existing `"[SCORE: {score:.4f}] {snippet}"`
        formatting so legacy callers see no change. `hits` carries the raw
        point metadata (untransformed text, real score, source file, chunk id)
        so structured consumers don't have to parse the human-formatted string.
        """
        query_vector = self.embed_query([query])[0]
        if not query_vector:
            logger.info("Failed to create embedding for the query.")
            return (["I'm sorry, I couldn't understand that question."], [])

        # Use self.top_k here as well
        top_k = self.top_k

        manager = QdrantManager(collection_name)
        search_results = manager.search(query_vector, top_k=top_k)  # returns List[ScoredPoint]

        if not search_results:
            logger.info("No matches found in Qdrant for semantic search.")
            return (["No relevant context found."], [])

        docs: List[str] = []
        hits: List[Dict[str, Any]] = []
        for point in search_results:
            payload = point.payload or {}
            score = float(point.score) if point.score is not None else 0.0
            text = payload.get("text", "")
            snippet = text.replace("\n", " ")  # or keep newlines if you prefer
            docs.append(f"[SCORE: {score:.4f}] {snippet}")
            hits.append({
                "id": str(point.id),
                "score": score,
                "text": text,
                "source": payload.get("source_file"),
                "chunk_id": payload.get("chunk_id"),
            })

        return (docs, hits)

    def deep_semantic_search(self, query: str, collection_name: str) -> List[str]:
        """
        1. Embed the query.
        2. Search Qdrant for the top_k matches.
        3. Return a short snippet of each matched text along with its score.

        Thin back-compat wrapper around `deep_semantic_search_with_hits`.
        """
        docs, _ = self.deep_semantic_search_with_hits(query, collection_name)
        return docs

    def warm_up(self):
        """
        Perform a trivial query embedding to load/cache the model on the correct device.
        """
        logger.info("Warming up the query model with a trivial query embedding...")
        _ = self.embed_query(["Hello"])
        logger.info("Query model warm-up complete.")
