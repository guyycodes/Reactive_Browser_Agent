# controllers/config_controller.py

from fastapi import APIRouter, HTTPException
import yaml
import os

router = APIRouter()

CONFIG_PATH = os.path.join("src", "config.yml")

@router.post("/updateConfig")
async def update_config(updates: dict):
    """
    Updates the config.yml with the provided values.
    
    The JSON payload should be a dictionary (potentially nested) containing the values you wish to update.
    For example:
    {
        "agent": {
            "embedding_model": {
                "batch_size": 64
            }
        },
        "qdrant": {
            "port": 7000
        }
    }
    
    If a key does not exist or the type of the provided value does not match the current config, 
    the endpoint will respond with an error.
    """
    # Load the current configuration
    try:
        with open(CONFIG_PATH, "r") as f:
            config = yaml.safe_load(f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load config file: {e}")

    errors = []

    def recursive_update(current: dict, changes: dict, path: str = ""):
        """
        Recursively update the current config with changes.
        Accumulates errors if a key is not found or if the type does not match.
        """
        for key, value in changes.items():
            current_path = f"{path}.{key}" if path else key

            if key not in current:
                errors.append(f"Key '{current_path}' does not exist.")
            else:
                # If both the current value and the update are dicts, perform recursive update.
                if isinstance(current[key], dict) and isinstance(value, dict):
                    recursive_update(current[key], value, current_path)
                else:
                    # Check if the type of the new value matches the type of the existing value.
                    expected_type = type(current[key])
                    if not isinstance(value, expected_type):
                        errors.append(
                            f"Wrong type for key '{current_path}'. Expected {expected_type.__name__}, got {type(value).__name__}."
                        )
                    else:
                        current[key] = value

    recursive_update(config, updates)

    if errors:
        raise HTTPException(status_code=400, detail=errors)

    # Write the updated configuration back to the YAML file.
    try:
        with open(CONFIG_PATH, "w") as f:
            yaml.dump(config, f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to write config file: {e}")

    return {"message": "Config updated successfully", "config": config}
    