# hugging_face_init.py
import logging
from pathlib import Path

import torch
from transformers import AutoTokenizer, AutoModel, AutoConfig
import yaml

from src.util.get_agent_config import load_agent_config

logger = logging.getLogger(__name__)

class HuggingFaceModel:
    """
    A flexible initializer for any Hugging Face model.
    Reads configuration from config.yml and loads the model, tokenizer,
    and model configuration.
    """
    def __init__(self, model_name: str = None, device: str = None):
        config = load_agent_config()
        agent_cfg = config.get("agent", {})

        # Use a provided model name or fall back to the config's agent.mode_name.
        self.model_name = model_name if model_name else agent_cfg.get("mode_name")
        if not self.model_name:
            raise ValueError(
                "Model name must be provided either as an argument or in config.yml under agent.mode_name."
            )

        # Use the provided device or the one defined under agent.embedding_model.
        embedding_cfg = agent_cfg.get("embedding_model", {})
        self.device = device if device else embedding_cfg.get("device", "cpu")

        logger.info(f"Initializing HuggingFaceModel: {self.model_name} on device {self.device}")

        # Load and tweak the model configuration.
        self.hf_config = AutoConfig.from_pretrained(self.model_name, trust_remote_code=True)
        self.hf_config.is_decoder = False
        self.hf_config.block_size = 4096
        self.hf_config.sparse_block_size = 4096
        self.hf_config.sparsity_factor = 1
        self.hf_config.sparsity_type = "norm"
        self.hf_config.adaptive = True
        self.hf_config.num_global_tokens = 0
        self.hf_config.pool_with_global = True

        # Initialize tokenizer and model.
        self.tokenizer = AutoTokenizer.from_pretrained(self.model_name, trust_remote_code=True)
        self.model = AutoModel.from_pretrained(self.model_name, config=self.hf_config, trust_remote_code=True)

        # Move the model to the desired device and set to evaluation mode.
        self.model.to(self.device)
        self.model.eval()
