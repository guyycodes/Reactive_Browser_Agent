# src/util/clean_doc_queue.py
import os
import logging
from queue import Queue
from watchfiles import watch

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

class CleanDocQueue:
    """
    Monitors the directory 'src/util/clean_docs' (recursively) for any changes.
    Only files named 'finished.txt' are added to the queue.
    """
    def __init__(self, base_dir: str = os.path.join("src", "util", "clean_docs"), max_queue_size: int = 1000):
        self.base_dir = base_dir
        self.queue = Queue(maxsize=max_queue_size)

    def run(self):
        logger.info("Starting monitoring for clean documents...")
        for changes in watch(self.base_dir, recursive=True):
            for change_type, file_path in changes:
                if os.path.basename(file_path) == "finished.txt":
                    try:
                        self.queue.put(file_path, block=False)
                        logger.info(f"Enqueued finished document: {file_path}")
                    except Exception as e:
                        logger.error(f"Error enqueuing '{file_path}': {e}")
