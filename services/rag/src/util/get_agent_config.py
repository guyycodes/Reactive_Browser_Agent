# /src/util/get_agent_config.py

import logging
import yaml
from pathlib import Path
from typing import Dict

logger = logging.getLogger(__name__)

# The settings.yml file is assumed to be at the root of your project.
CONFIG_PATH = Path(__file__).parent.parent.parent / "config.yml"

def load_agent_config() -> Dict:
    if not CONFIG_PATH.exists():
        logger.warning(f"Config file not found: {CONFIG_PATH}")
        return {}
    try:
        with open(CONFIG_PATH, "r", encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        return data
    except Exception as e:
        logger.error(f"Failed to load config {CONFIG_PATH}: {e}")
        return {}
