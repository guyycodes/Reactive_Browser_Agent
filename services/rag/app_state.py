# app_state.py
from threading import Lock

# Global shared embedder and query model (initially None)
current_embedder = None
current_model_name = None  # the model currently in use
embedder_model_lock = Lock()  # protects the above globals