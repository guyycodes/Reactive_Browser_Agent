# main.py

import logging
import time
import signal
from threading import Thread, Lock, current_thread, Event
from queue import Empty

from src.util.queue import FileQueue
from src.util.document_cleaning_pipline import DocumentCleaner
from src.util.clean_doc_queue import CleanDocQueue
from src.util.get_agent_config import load_agent_config
from initializers import warm_up_embedder
from app_state import embedder_model_lock, current_embedder, current_model_name

# --- FastAPI imports ---
import uvicorn
from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from controllers import api_router  # Import router from controllers


logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

### Configuration for the document cleaning pipeline ###
INITIAL_CONSUMER_COUNT = 2
MAX_CONSUMER_COUNT = 10
QUEUE_THRESHOLD = 100     # When the queue has >100 items, spawn extra consumers.
CONSUMER_TIMEOUT = 10     # Timeout in seconds for idle consumer threads.

consumer_threads = []
consumer_lock = Lock()

shared_config = {}
config_lock = Lock()

### Configuration for the embedding pipeline ###
INITIAL_EMBEDDING_CONSUMER_COUNT = 2
MAX_EMBEDDING_CONSUMER_COUNT = 10
EMBEDDING_QUEUE_THRESHOLD = 100
EMBEDDING_CONSUMER_TIMEOUT = 10

embedding_consumer_threads = []
embedding_consumer_lock = Lock()

### Event used to trigger graceful shutdown
shutdown_event = Event()
###############################################################################
# EDGE-CASE HANDLING & DYNAMIC CONFIG REFRESH
###############################################################################
def config_refresher(interval=5):
    """
    Periodically reloads the configuration and updates a shared dictionary.
    Includes error handling so an invalid config doesn't crash the refresher.
    """
    global current_embedder, current_model_name

    while not shutdown_event.is_set():
        try:
            new_config = load_agent_config()  # Potentially raises an exception
        except Exception as e:
            logger.error(f"Failed to load config in refresher: {e}. Skipping this cycle.")
            time.sleep(interval)
            continue

        with config_lock:
            shared_config.clear()
            shared_config.update(new_config)
        
        # Check for model_name update
        with config_lock:
            new_model_name = shared_config.get("agent", {}).get("model_name", "guymorganb/e5-large-v2-4096-lsg-patched")
        
        with embedder_model_lock:
            if new_model_name != current_model_name:
                logger.info(f"Model name changed from {current_model_name} to {new_model_name}. Updating embedder model.")
                current_embedder = warm_up_embedder(model_name=new_model_name)
                current_model_name = new_model_name

        time.sleep(interval)
###############################################################################
# DOCUMENT CLEANING PIPELINE
###############################################################################
def consumer_worker(file_queue: FileQueue, cleaner: DocumentCleaner):
    logger.info(f"Document cleaning consumer {current_thread().name} started.")
    while True:
        try:
            file_path = file_queue.queue.get(timeout=CONSUMER_TIMEOUT)
            logger.info(f"{current_thread().name} processing file: {file_path}")
            result = cleaner.process_document_from_queue(file_path)
            logger.info(f"{current_thread().name} result: {result}")
            file_queue.queue.task_done()
        except Empty:
            # Check if we can reduce consumer threads
            with consumer_lock:
                if len(consumer_threads) > INITIAL_CONSUMER_COUNT:
                    logger.info(f"{current_thread().name} exiting (idle).")
                    consumer_threads[:] = [t for t in consumer_threads if t.name != current_thread().name]
                    break
            continue
        except Exception as e:
            logger.error(f"{current_thread().name} encountered error: {e}")
            file_queue.queue.task_done()
################################################################################################
def monitor_consumers(file_queue: FileQueue, cleaner: DocumentCleaner):
    while not shutdown_event.is_set():
        if file_queue.queue.qsize() > QUEUE_THRESHOLD:
            with consumer_lock:
                if len(consumer_threads) < MAX_CONSUMER_COUNT:
                    t = Thread(target=consumer_worker, args=(file_queue, cleaner), daemon=True)
                    consumer_threads.append(t)
                    t.start()
                    logger.info(f"Spawned cleaning consumer. Total: {len(consumer_threads)}")
        time.sleep(5)
    logger.info("monitor_consumers thread shutting down gracefully.")

###############################################################################
# EMBEDDING PIPELINE
###############################################################################
def embedding_consumer_worker(clean_doc_queue: CleanDocQueue):
    """
    Uses the warmed-up embedder to process documents.
    """
    logger.info(f"Embedding consumer {current_thread().name} started.")
    while not shutdown_event.is_set():
        try:
            file_path = clean_doc_queue.queue.get(timeout=EMBEDDING_CONSUMER_TIMEOUT)
            logger.info(f"{current_thread().name} processing clean doc: {file_path}")
            
            with config_lock:
                a = shared_config.get("agent", {})
                embedding_model = a.get("embedding_model", {})
                embed_flag = embedding_model.get("will_embed_docs")   
            # Before embedding, get the current embedder
            with embedder_model_lock:
                embedder_to_use = current_embedder

            if embed_flag and embedder_to_use:
                result = embedder_to_use.embed_document(file_path)
                logger.info(f"{current_thread().name} embedded result: {result}")
            else:
                logger.info(f"{current_thread().name} skipping embedding as per config.")

            clean_doc_queue.queue.task_done()
        except Empty:
            with embedding_consumer_lock:
                if len(embedding_consumer_threads) > INITIAL_EMBEDDING_CONSUMER_COUNT:
                    logger.info(f"{current_thread().name} exiting (idle).")
                    embedding_consumer_threads[:] = [t for t in embedding_consumer_threads if t.name != current_thread().name]
                    break
            continue
        except Exception as e:
            logger.error(f"{current_thread().name} encountered error: {e}")
            clean_doc_queue.queue.task_done()

    logger.info(f"Embedding consumer {current_thread().name} shutting down gracefully.")

################################################################################################
def monitor_embedding_consumers(clean_doc_queue: CleanDocQueue):
    while not shutdown_event.is_set():
        if clean_doc_queue.queue.qsize() > EMBEDDING_QUEUE_THRESHOLD:
            with embedding_consumer_lock:
                if len(embedding_consumer_threads) < MAX_EMBEDDING_CONSUMER_COUNT:
                    t = Thread(target=embedding_consumer_worker, args=(clean_doc_queue,), daemon=True)
                    embedding_consumer_threads.append(t)
                    t.start()
                    logger.info(f"Spawned embedding consumer. Total: {len(embedding_consumer_threads)}")
        time.sleep(5)
    logger.info("monitor_embedding_consumers thread shutting down gracefully.")

###############################################################################
# FASTAPI SERVER & DIAGNOSTICS
############################################################################### 
def create_api_app():
    api_app = FastAPI(
        title="Text Processing Pipline API",
        description="An API that handles document processing",
        version="1.0.0"
    )
    
    # 1) Mount the React build directory (if applicable)
    # api_app.mount("/", StaticFiles(directory="frontend/build", html=True), name="react-frontend")
    
    # 2) Include your /upload route (and any other routes) from controllers.
    api_app.include_router(api_router, prefix="/docs")  
    # Using prefix="/api" means the /upload route will actually be at /api/upload

    # 3) Add a diagnostic endpoint
    @api_app.get("/monitor")
    def monitor():
        """
        Return current queue sizes and active thread counts for debugging/monitoring.
        """
        with consumer_lock:
            cleaning_consumers_count = len(consumer_threads)
        with embedding_consumer_lock:
            embedding_consumers_count = len(embedding_consumer_threads)
        
        file_queue_size = file_queue.queue.qsize() if file_queue else -1
        clean_doc_queue_size = clean_doc_queue.queue.qsize() if clean_doc_queue else -1
        
        return {
            "cleaning_consumers_count": cleaning_consumers_count,
            "embedding_consumers_count": embedding_consumers_count,
            "file_queue_size": file_queue_size,
            "clean_doc_queue_size": clean_doc_queue_size,
            "model_in_use": current_model_name
        }

    return api_app

def start_fastapi_server(api_app: FastAPI):
    uvicorn.run(api_app, host="0.0.0.0", port=3009, log_level="info")
###############################################################################
# GRACEFUL SHUTDOWN LOGIC
###############################################################################
def handle_signal(signum, frame):
    """
    Sets the shutdown_event so that all loops and threads can exit gracefully.
    """
    logger.info(f"Received shutdown signal (signal: {signum}). Initiating graceful shutdown...")
    shutdown_event.set()
###############################################################################
# MAIN ENTRY POINT
###############################################################################
def main():
    global current_embedder, current_model_name
    
    # Register signal handlers for graceful shutdown
    signal.signal(signal.SIGINT, handle_signal)
    signal.signal(signal.SIGTERM, handle_signal)

    logger.info("Starting main application...")

    # Prepare the queues
    global file_queue, clean_doc_queue
    file_queue = FileQueue()
    clean_doc_queue = CleanDocQueue()

    # Start the background threads for queue monitoring
    file_queue_monitor = Thread(target=file_queue.run, daemon=True)
    file_queue_monitor.start()
    logger.info("Started FileQueue monitoring for dirty documents.")

    clean_doc_monitor = Thread(target=clean_doc_queue.run, daemon=True)
    clean_doc_monitor.start()
    logger.info("Started CleanDocQueue monitoring for clean documents.")

    # Start initial document cleaning consumers
    cleaner = DocumentCleaner()
    for _ in range(INITIAL_CONSUMER_COUNT):
        t = Thread(target=consumer_worker, args=(file_queue, cleaner), daemon=True)
        with consumer_lock:
            consumer_threads.append(t)
        t.start()
    logger.info(f"Started {INITIAL_CONSUMER_COUNT} cleaning consumer threads.")
    
    scaling_thread = Thread(target=monitor_consumers, args=(file_queue, cleaner), daemon=True)
    scaling_thread.start()
    logger.info("Started document cleaning scaling monitor.")

    # Initialize and warm up embedding model
    try:
        agnt_config = load_agent_config()
    except Exception as e:
        logger.error(f"Failed to load initial config: {e}")
        agnt_config = {}  # fallback to empty config

    a = agnt_config.get("agent", {})
    current_model_name = a.get("model_name", "guymorganb/e5-large-v2-4096-lsg-patched")
    with embedder_model_lock:
        current_embedder = warm_up_embedder(model_name=current_model_name)
       

    # Start embedding consumers
    for _ in range(INITIAL_EMBEDDING_CONSUMER_COUNT):
        t = Thread(target=embedding_consumer_worker, args=(clean_doc_queue,), daemon=True)
        with embedding_consumer_lock:
            embedding_consumer_threads.append(t)
        t.start()
    logger.info(f"Started {INITIAL_EMBEDDING_CONSUMER_COUNT} embedding consumer threads.")

    embedding_scaling_thread = Thread(target=monitor_embedding_consumers, args=(clean_doc_queue,), daemon=True)
    embedding_scaling_thread.start()
    logger.info("Started embedding consumer scaling monitor.")

    # Start FastAPI in a separate thread
    api_app = create_api_app()
    api_thread = Thread(target=start_fastapi_server, args=(api_app,), daemon=True)
    api_thread.start()
    logger.info("Started FastAPI server on separate thread.")

    # Start the config refresher
    refresher_thread = Thread(target=config_refresher, daemon=True)
    refresher_thread.start()
    logger.info("Started configuration refresher.")

    # Keep main thread alive until shutdown_event is set
    while not shutdown_event.is_set():
        time.sleep(1)

    # GRACEFUL SHUTDOWN: Wait for threads to exit or forcibly terminate
    logger.info("Main loop exiting. Waiting for threads to finish...")

    # join threads if not daemon. Since most threads are daemon, they will exit automatically.
    # with non-daemon threads, you'd want to do:
    # for t in consumer_threads:
    #     t.join()
    # etc.

    logger.info("Application shutdown complete.")


if __name__ == "__main__":
    main()

