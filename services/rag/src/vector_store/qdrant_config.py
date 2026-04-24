import os
import threading
import time
import logging
from pathlib import Path
from typing import List
from qdrant_client import QdrantClient
from qdrant_client.models import Distance, VectorParams, PointStruct, Filter, ScoredPoint

from src.util.get_agent_config import load_agent_config

logger = logging.getLogger(__name__)

# Serialises collection-creation across embedder threads so multiple workers
# writing the first point to a brand-new collection don't race on the create
# call. Without this, two threads both see "collection doesn't exist", both
# try to create, and the second loses with a 409 Conflict — which would
# otherwise bubble up and silently drop that worker's upsert.
_COLLECTION_CREATE_LOCK = threading.Lock()

def _parse_int(value, field_name):
    """Attempt to parse an int; raise ValueError if invalid."""
    try:
        return int(value)
    except ValueError:
        raise ValueError(f"Field '{field_name}' must be an integer, got '{value}'")


def _parse_float(value, field_name):
    """Attempt to parse a float; raise ValueError if invalid."""
    try:
        return float(value)
    except ValueError:
        raise ValueError(f"Field '{field_name}' must be a float, got '{value}'")


def _check_required_fields(mode: str, qdrant_cfg: dict):
    """
    Ensure all required fields for the given mode are present.
    If a required field is missing or invalid, raise an exception.
    """
    mode = mode.upper()
    if mode == "CLOUD":
        required_fields = [
            "QDRANT_CLOUD_HOST",
            "QDRANT_CLOUD_PORT",
            "QDRANT_CLOUD_API_KEY",
            "timeout",
            "dimension",
        ]
    else:
        # Default to LOCAL if not set or invalid
        required_fields = [
            "host",
            "port",
            "timeout",
            "dimension",
        ]
    for field in required_fields:
        if field not in qdrant_cfg:
            raise ValueError(f"Missing required field '{field}' in 'qdrant' config for mode '{mode}'")
        if qdrant_cfg[field] is None:
            raise ValueError(f"Field '{field}' in 'qdrant' config for mode '{mode}' cannot be None")


class QdrantManager:
    """
    A unified class for:
      1) Reading LOCAL vs. CLOUD Qdrant configuration.
      2) Creating/holding a single QdrantClient.
      3) Ensuring a collection exists.
      4) Upserting and searching points in batches with logging.
    """

    # --- 1) CLASS-LEVEL CONFIG LOADING (EXECUTES ON IMPORT) ---
    _agent_config = load_agent_config()
    # Read the 'qdrant' section from settings.yml.
    _qdrant_cfg = _agent_config.get("qdrant", {})

    # Determine mode (defaulting to LOCAL if not set)
    _mode = str(_qdrant_cfg.get("mode", "LOCAL")).upper()

    # Validate required fields for the chosen mode.
    _check_required_fields(_mode, _qdrant_cfg)

    if _mode == "CLOUD":
        # Cloud-specific configuration.
        _host = _qdrant_cfg["QDRANT_CLOUD_HOST"]
        _port = _parse_int(_qdrant_cfg["QDRANT_CLOUD_PORT"], "QDRANT_CLOUD_PORT")
        _api_key = _qdrant_cfg["QDRANT_CLOUD_API_KEY"]
        _timeout = _parse_float(_qdrant_cfg["timeout"], "timeout")
        _prefer_grpc = bool(_qdrant_cfg.get("QDRANT_PREFER_GRPC", False))
        _dimension = _parse_int(_qdrant_cfg["dimension"], "dimension")

        # Example gRPC keepalive options (tweak as needed):
        _grpc_opts = {
            "grpc.keepalive_time_ms": 300000,     # 5 min
            "grpc.keepalive_timeout_ms": 20000,   # 20 s
        }

        _qdrant_client = QdrantClient(
            host=_host,
            port=_port,
            api_key=_api_key,
            prefer_grpc=_prefer_grpc,
            timeout=_timeout,
            grpc_options=_grpc_opts  # only used if prefer_grpc=True
        )
    else:
        # LOCAL configuration.
        _host = _qdrant_cfg["host"]
        _port = _parse_int(_qdrant_cfg["port"], "port")
        _timeout = _parse_float(_qdrant_cfg["timeout"], "timeout")
        _dimension = _parse_int(_qdrant_cfg["dimension"], "dimension")
        _prefer_grpc = bool(_qdrant_cfg.get("QDRANT_PREFER_GRPC", False))

        # Example gRPC keepalive options (tweak as needed):
        _grpc_opts = {
            "grpc.keepalive_time_ms": 300000,     # 5 min
            "grpc.keepalive_timeout_ms": 20000,   # 20 s
        }

        _qdrant_client = QdrantClient(
            host=_host,
            port=_port,
            timeout=_timeout,
            prefer_grpc=_prefer_grpc,
            grpc_options=_grpc_opts  # only used if prefer_grpc=True
        )

    # Additional metadata
    DISTANCE_METRIC = Distance.COSINE
    VECTOR_DIM = _dimension

    # --- 2) STATIC METHODS ---
    @staticmethod
    def ensure_qdrant_collection(collection_name: str):
        """
        Ensure the named collection exists in Qdrant, creating it if it doesn't.

        Concurrency-safe: a module-level lock serialises the
        check-then-create sequence so multiple worker threads upserting
        simultaneously into a brand-new collection don't race. If another
        thread has created the collection between our check and our create
        call (or if Qdrant returns 409 Conflict for any other reason), we
        treat that as success — the end state we wanted is "collection
        exists," and it does.
        """
        client = QdrantManager._qdrant_client  # Use our class-level client.
        dim = QdrantManager.VECTOR_DIM
        metric = QdrantManager.DISTANCE_METRIC

        with _COLLECTION_CREATE_LOCK:
            existing = client.get_collections()
            coll_names = [c.name for c in existing.collections]

            if collection_name not in coll_names:
                logger.info(
                    f"Creating Qdrant collection: {collection_name} with dimension={dim}, distance={metric}"
                )
                try:
                    client.create_collection(
                        collection_name=collection_name,
                        vectors_config=VectorParams(size=dim, distance=metric),
                    )
                except Exception as e:
                    # Tolerate "already exists" races from a parallel worker
                    # that slipped past us (e.g. separate process, or lock
                    # lost to GIL reordering under very high contention).
                    msg = str(e).lower()
                    if "already exists" in msg or "409" in msg or "conflict" in msg:
                        logger.info(
                            f"Collection '{collection_name}' already exists "
                            f"(raced with another worker); continuing."
                        )
                    else:
                        raise
            else:
                logger.debug(f"Collection {collection_name} already exists.")
                # Verify the collection's dimension matches our embedder's.
                info = client.get_collection(collection_name=collection_name)
                current_dim = info.config.params.vectors.size
                if current_dim != dim:
                    logger.warning(
                        f"Collection '{collection_name}' dimension={current_dim}, expected={dim}. Re-creating!"
                    )
                    client.recreate_collection(
                        collection_name=collection_name,
                        vectors_config=VectorParams(size=dim, distance=metric),
                    )
                else:
                    logger.debug(f"Dimension is correct ({current_dim}). No action needed.")

    @staticmethod
    def get_collections():
        """
        Return all collections from the Qdrant instance.
        """
        return QdrantManager._qdrant_client.get_collections()

    @staticmethod
    def upsert_points(collection_name: str, points: List[PointStruct], batch_size: int = 200):
        """
        Upsert points into the specified collection in batches of `batch_size`.
        Adds extra logging to diagnose timeouts.
        """
        total_points = len(points)
        logger.info(f"[QdrantManager] Starting upsert of {total_points} points to collection='{collection_name}'")

        # Let’s break it down into smaller requests
        for start_idx in range(0, total_points, batch_size):
            batch_end = start_idx + batch_size
            subset = points[start_idx:batch_end]

            logger.info(f"[QdrantManager] Upserting points {start_idx}..{batch_end - 1} out of {total_points}")

            start_time = time.time()
            try:
                QdrantManager._qdrant_client.upsert(
                    collection_name=collection_name,
                    points=subset,
                    # override method timeout if needed:
                    
                )
            except Exception as exc:
                logger.error(
                    f"[QdrantManager] Upsert failed at batch {start_idx}..{batch_end - 1}: {exc}"
                )
                raise

            elapsed = time.time() - start_time
            logger.info(
                f"[QdrantManager] Successfully upserted {len(subset)} points in "
                f"{elapsed:.2f} sec to '{collection_name}'"
            )

        logger.info(f"[QdrantManager] Done upserting all {total_points} points to '{collection_name}'.")

    # --- 3) INSTANCE METHODS ---
    def __init__(self, collection_name: str):
        """
        Instantiate a QdrantManager for a specific collection.
        """
        self.collection_name = collection_name
        
    def collection_exists(self) -> bool:
        """
        Return True if self.collection_name exists in Qdrant, else False.
        """
        try:
            collections = self._qdrant_client.get_collections()
            existing_names = [c.name for c in collections.collections]
            return self.collection_name in existing_names
        except Exception as exc:
            logger.error(f"Error checking collection existence: {exc}")
            return False

    def search(self, query_vector: List[float], top_k: int) -> List[ScoredPoint]:
        """
        Search the specified collection for the top_k closest points.
        Returns a list of ScoredPoint objects.
        """
        return QdrantManager._qdrant_client.search(
            collection_name=self.collection_name,
            query_vector=query_vector,
            limit=top_k,
            # You can set a search timeout if needed
        )
