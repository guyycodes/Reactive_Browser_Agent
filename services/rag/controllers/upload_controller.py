# controllers/upload_controller.py

import os
import asyncio
import aiofiles
from fastapi import APIRouter, UploadFile, File, HTTPException
from fastapi import BackgroundTasks
from typing import Optional

router = APIRouter()

# Base directory for "dirty_documents" - adjust to your actual path
BASE_DIR = "/app/src/util/dirty_documents"


@router.post("/documents")
async def upload_file(
    background_tasks: BackgroundTasks,
    file: UploadFile = File(...),
    subfolder: Optional[str] = None
):
    """
    Asynchronously accept file uploads without blocking.
    - If subfolder is not provided, uses the file extension.
    - The file is saved under src/util/dirty_documents/<extension>/filename.
    """

    # 1. Get original filename & extension
    original_filename = file.filename
    if not original_filename:
        raise HTTPException(status_code=400, detail="No filename provided.")

    # For example, if file is "document.pdf", extension=".pdf", ext="pdf"
    _, extension_with_dot = os.path.splitext(original_filename)
    ext = extension_with_dot.lower().replace(".", "")  # e.g. "pdf"

    # If the client explicitly provides a subfolder, we can respect that;
    # otherwise, we default to the extension-based folder.
    if subfolder:
        target_subfolder = subfolder
    else:
        # If there's no recognized extension, store in "other"
        target_subfolder = ext if ext else "other"

    # 2. Construct the target directory path
    target_dir = os.path.join(BASE_DIR, target_subfolder)
    os.makedirs(target_dir, exist_ok=True)

    # 3. Build the full file path
    target_path = os.path.join(target_dir, original_filename)

    # 4. Asynchronously read the file and write it to disk in chunks
    try:
        # If you want to do a streaming write to handle very large files:
        chunk_size = 1024 * 1024  # 1 MB chunks (adjust as needed)
        async with aiofiles.open(target_path, 'wb') as out_file:
            while True:
                chunk = await file.read(chunk_size)
                if not chunk:
                    break
                await out_file.write(chunk)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to write file: {str(e)}")

    # 5. (Optional) Do post-upload tasks in the background
    background_tasks.add_task(
        post_upload_log,
        original_filename=original_filename,
        saved_path=target_path
    )

    # 6. Return a JSON response
    return {
        "message": "File uploaded successfully",
        "filename": original_filename,
        "saved_to": target_path
    }

async def post_upload_log(original_filename: str, saved_path: str):
    """
    Example background task that logs or processes the file
    after it's successfully saved.
    """
    # Here we just simulate some async logging
    await asyncio.sleep(0.1)
    print(f"[post_upload_log] File '{original_filename}' saved to '{saved_path}'.")


@router.get("/health")
async def upload_info():
    """
    Simple GET endpoint to show that uploads are working.
    """
    return {"message": "Upload endpoint is ready."}
