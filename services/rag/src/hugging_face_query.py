# src/hugging_face_query.py
import logging
from transformers import AutoTokenizer, AutoModel, AutoConfig
import torch

from src.util.get_agent_config import load_agent_config

logger = logging.getLogger(__name__)

class HuggingFaceQuery:
    """
    Base class for initializing a query model from Hugging Face.
    Reads configuration from config.yml and loads the model, tokenizer,
    and model configuration specific to the query model.
    """
    def __init__(self, model_name: str = None, device: str = None):
        config = load_agent_config()
        agent_cfg = config.get("agent", {})
        query_cfg = agent_cfg.get("query_model", {})

        # Use provided model_name OR fallback to "agent.query_model.model_name" 
        # OR "agent.model_name" from the config.
        self.model_name = (
            model_name
            if model_name
            else query_cfg.get("model_name", agent_cfg.get("model_name"))
        )
        if not self.model_name:
            raise ValueError(
                "A model name must be provided either as an argument or in the config "
                "(agent.model_name or agent.query_model.model_name)."
            )

        self.device = device if device else query_cfg.get("device", "cpu")

        logger.info(f"Initializing HuggingFaceQuery: {self.model_name} on device {self.device}")

        # Load and adjust the Hugging Face configuration.
        self.hf_config = AutoConfig.from_pretrained(self.model_name, trust_remote_code=True)
        self.hf_config.is_decoder = False
        self.hf_config.block_size = 4096
        self.hf_config.sparse_block_size = 4096
        self.hf_config.sparsity_factor = 1
        self.hf_config.sparsity_type = "norm"
        self.hf_config.adaptive = True
        self.hf_config.num_global_tokens = 0
        self.hf_config.pool_with_global = True

        # Initialize the tokenizer and model.
        self.tokenizer = AutoTokenizer.from_pretrained(self.model_name, trust_remote_code=True)
        self.model = AutoModel.from_pretrained(self.model_name, config=self.hf_config, trust_remote_code=True)
        self.model.to(self.device)
        self.model.eval()
