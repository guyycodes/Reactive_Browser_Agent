#!/usr/bin/env python3
"""
configurator.py

A CLI script for:
1) Updating the config.yml with user-selected model/device/etc.
2) Testing that we can load and embed a short sample text using our EmbeddingModel.
3) Interacting with the QueryModel for QA search or deep semantic search.
"""

import yaml
import questionary
import logging
from pathlib import Path
import sys
import os

# Ensure the project root is in the Python path.
sys.path.append(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from src.model.embedding_model import EmbeddingModel
from src.model.query_model import QueryModel
from src.util.get_agent_config import load_agent_config
from src.vector_store.qdrant_config import QdrantManager

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

CONFIG_FILENAME = "config.yml"


def load_config(config_path: str = CONFIG_FILENAME) -> dict:
    """
    Loads YAML config from disk. Returns an empty dict if file not found.
    """
    config_file = Path(config_path)
    if not config_file.exists():
        logger.warning(f"Config file {config_file} not found. Starting with empty config.")
        return {}
    with config_file.open("r", encoding="utf-8") as f:
        return yaml.safe_load(f) or {}


def save_config(config_data: dict, config_path: str = CONFIG_FILENAME):
    """
    Saves config data to the specified YAML file.
    """
    with open(config_path, "w", encoding="utf-8") as f:
        yaml.dump(config_data, f, sort_keys=False)
    logger.info(f"✅ Configuration saved to {config_path}.")


def update_configuration():
    """
    Prompts the user for important config settings and writes them to config.yml.
    """
    print("\n=== Update Configuration ===\n")

    # Load existing config so we can preserve some keys the user doesn't want to change.
    current_config = load_config(CONFIG_FILENAME)

    # Ensure required keys exist.
    if "agent" not in current_config:
        current_config["agent"] = {}
    if "embedding_model" not in current_config["agent"]:
        current_config["agent"]["embedding_model"] = {}
    if "query_model" not in current_config["agent"]:
        current_config["agent"]["query_model"] = {}
    if "text_splitter" not in current_config:
        current_config["text_splitter"] = {}
    if "dirty_documents" not in current_config:
        current_config["dirty_documents"] = {
            "base_dir": "src/util/dirty_documents",
            "docx": "docx",
            "html": "html",
            "other": "other",
            "pdf": "pdf",
            "temp": "temp"
        }
    if "processed_output_dir" not in current_config:
        current_config["processed_output_dir"] = "src/util/clean_docs"
    if "qdrant" not in current_config:
        current_config["qdrant"] = {}

    # Define a mapping from known model names to their vector dimensions.
    model_vector_dims = {
        "microsoft/deberta-v2-xlarge": 1536,
        "microsoft/BiomedNLP-PubMedBERT-base-uncased-abstract": 768,
        "nlpaueb/legal-bert-base-uncased": 768,
        "ProsusAI/finbert": 768,
        "thellert/physbert_cased": 768,
        "guymorganb/e5-large-v2-4096-lsg-patched": 1024,
        "allenai/scibert_scivocab_uncased": 768,
        "microsoft/codebert-base": 768,
        "intfloat/e5-large": 1024,
    }

    # Prompt for the Hugging Face model name.
    model_name = questionary.select(
        "Select Hugging Face model for embeddings:",
        choices=[
            "microsoft/deberta-v2-xlarge",
            "microsoft/BiomedNLP-PubMedBERT-base-uncased-abstract",
            "nlpaueb/legal-bert-base-uncased",
            "ProsusAI/finbert",
            "thellert/physbert_cased",
            "guymorganb/e5-large-v2-4096-lsg-patched",
            "allenai/scibert_scivocab_uncased",
            "microsoft/codebert-base",
            "intfloat/e5-large",
            "Other (manually enter)",
        ],
        default="microsoft/deberta-v2-xlarge"
    ).ask()

    # If "Other" is chosen, prompt the user for both model identifier and vector dimension.
    if model_name == "Other (manually enter)":
        model_name = questionary.text("Enter the Hugging Face model identifier:").ask()
        vector_dim = int(questionary.text(
            "Enter the vector dimension for the custom model (e.g., 768 or 1024, 1536):",
            default="768"
        ).ask())
    else:
        # Look up the vector dimension based on the chosen model.
        vector_dim = model_vector_dims.get(model_name)
        if vector_dim is None:
            # Fallback: prompt the user if the model isn't in our mapping.
            vector_dim = int(questionary.text(
                f"Vector dimension for {model_name} not found. Please enter the vector dimension:",
                default="768"
            ).ask())

    # Prompt for device.
    device = questionary.select(
        "Select device for the embedding model:",
        choices=["cpu", "cuda", "mps"],
        default="mps"
    ).ask()

    # Prompt for maximum tokens.
    max_tokens = questionary.text(
        "Enter maximum tokens (default 4096):",
        default="4096"
    ).ask()

    # Prompt for batch size for embedding.
    batch_size = questionary.text(
        "Enter batch size for embedding (default 32):",
        default="32"
    ).ask()

    # Update agent settings.
    current_config["agent"]["model_name"] = model_name
    current_config["agent"]["embedding_model"]["device"] = device
    current_config["agent"]["embedding_model"]["max_tokens"] = int(max_tokens)
    current_config["agent"]["embedding_model"]["batch_size"] = int(batch_size)

    # Also update query_model settings (if needed).
    current_config["agent"]["query_model"]["device"] = device
    current_config["agent"]["query_model"]["max_tokens"] = int(max_tokens)
    top_k = questionary.text(
        "Enter top_k for query searches (default 5):",
        default="5"
    ).ask()
    current_config["agent"]["query_model"]["top_k"] = int(top_k)

    # Update Qdrant settings with the determined vector dimension.
    current_config["qdrant"]["dimension"] = vector_dim

    # ------------------------ ADDED FOR QDRANT COLLECTION ------------------------
    # Prompt user for the Qdrant collection name (default to whatever's in config, fallback "document_vectors")
    collection_name = questionary.text(
        "Enter Qdrant collection name (default: 'document_vectors'):",
        default=current_config["qdrant"].get("collection", "document_vectors")
    ).ask()
    current_config["qdrant"]["collection"] = collection_name
    # ----------------------------------------------------------------------------

    # Prompt for text splitting settings.
    chunk_size = questionary.text(
        "Enter chunk size in words (default 300):",
        default="300"
    ).ask()
    chunk_overlap = questionary.text(
        "Enter chunk overlap in words (default 10):",
        default="10"
    ).ask()
    current_config["text_splitter"]["chunk_size"] = int(chunk_size)
    current_config["text_splitter"]["chunk_overlap"] = int(chunk_overlap)

    # Prompt for the processed output directory.
    processed_output_dir = questionary.text(
        "Enter processed output directory (default src/util/clean_docs):",
        default="src/util/clean_docs"
    ).ask()
    current_config["processed_output_dir"] = processed_output_dir

    # Optionally prompt for the dirty_documents base directory.
    dirty_base = questionary.text(
        "Enter dirty documents base directory (default src/util/dirty_documents):",
        default="src/util/dirty_documents"
    ).ask()
    current_config["dirty_documents"]["base_dir"] = dirty_base

    # Save updated configuration.
    save_config(current_config, CONFIG_FILENAME)
    print("Configuration updated successfully.\n")


def test_embedding_model():
    """
    Loads the embedding model from config.yml and embeds a short text to verify functionality.
    """
    print("\n=== Test Embedding Model ===\n")

    sample_text = questionary.text(
        "Enter a short sample text to embed:",
        default="Hello world! This is a quick test."
    ).ask()

    try:
        embedder = EmbeddingModel()  # Uses the settings from config.yml
        # Warm-up if desired:
        embedder.warm_up()
    except Exception as e:
        print(f"❌ Error initializing EmbeddingModel: {e}")
        return

    print("Embedding the sample text...\n")
    try:
        embeddings = embedder.embed_documents([sample_text])
    except Exception as e:
        print(f"❌ Error during embedding: {e}")
        return

    if embeddings and len(embeddings) > 0:
        vector = embeddings[0]
        print(f"Success! Got an embedding vector of length: {len(vector)}")
    else:
        print("No embeddings returned. Check your model or configuration.")

    print("Test embedding complete.\n")


def test_query_model():
    """
    Demonstrates an interactive QueryModel usage:
      1) Loads the config to find the Qdrant collection name.
      2) Instantiates + warms up QueryModel.
      3) Asks user if they want a QA search or deep semantic search.
      4) Prompts for query, runs the chosen search, displays results.
    """
    print("\n=== Test Query Model ===\n")

    # 1) Load config and figure out Qdrant collection name (default to "document_vectors" if missing).
    config = load_config(CONFIG_FILENAME)
    qdrant_cfg = config.get("qdrant", {})
    collection_name = qdrant_cfg.get("collection", "document_vectors")

    # 2) Instantiate + warm up the QueryModel
    try:
        query_model = QueryModel()
        query_model.warm_up()
    except Exception as e:
        print(f"❌ Error initializing QueryModel: {e}")
        return

    while True:
        # 3) Ask user which search type
        search_type = questionary.select(
            "Select a query type:",
            choices=[
                "QA Search",
                "Deep Semantic Search",
                "Exit to main menu"
            ]
        ).ask()

        if search_type == "Exit to main menu":
            print("Returning to main menu...\n")
            break

        # 4) Prompt for the user query
        user_query = questionary.text(
            "Enter your query (type 'quit' to exit):"
        ).ask()

        if user_query.lower() in ("quit", "exit"):
            print("Returning to main menu...\n")
            break

        # 5) Perform the chosen search
        if search_type == "QA Search":
            results = query_model.qa_search(user_query, collection_name)
        else:  # "Deep Semantic Search"
            results = query_model.deep_semantic_search(user_query, collection_name)

        # 6) Display results
        print("\n=== Search Results ===")
        if not results:
            print("No results returned.")
        else:
            for idx, r in enumerate(results, 1):
                print(f"[{idx}] {r}")
        print("\n")


def main_menu():
    """
    The main CLI menu.
    """
    while True:
        choice = questionary.select(
            "Select an action:",
            choices=[
                "Update Configuration",
                "Test Embedding Model",
                "Test Query Model",
                "Exit"
            ]
        ).ask()

        if choice == "Update Configuration":
            update_configuration()
        elif choice == "Test Embedding Model":
            test_embedding_model()
        elif choice == "Test Query Model":
            test_query_model()
        else:
            print("Exiting CLI. Goodbye!")
            break


if __name__ == "__main__":
    main_menu()
