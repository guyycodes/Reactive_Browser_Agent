# src/util/queue.py
import os
import re
import shutil
import uuid
import logging
from queue import Queue
from watchfiles import watch

logger = logging.getLogger(__name__)
logging.basicConfig(level=logging.INFO)

# Matches a canonical UUID4 in a filename, e.g. "foo_a1b2c3d4-e5f6-4789-9abc-def012345678.html"
# The presence of this pattern in a dropped filename is the user opting-in to
# append to an existing vector store of the same UUID. Absence triggers
# auto-generation so each upload goes to its own new store.
UUID_RE = re.compile(
    r'[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}',
    re.IGNORECASE,
)


def tag_filename_with_uuid(filename: str) -> str:
    """Return a filename guaranteed to contain a UUID4 suffix before the extension.
    If one is already present, returns the filename unchanged. Otherwise appends
    `_<uuid4>` before the extension and returns the new name.
    """
    basename, ext = os.path.splitext(filename)
    if UUID_RE.search(basename):
        return filename
    return f"{basename}_{uuid.uuid4()}{ext}"

class FileQueue:
    """
    Monitors the subdirectories under `src/util/dirty_documents` for new files.
    The expected structure is:
      - src/util/dirty_documents/docx
      - src/util/dirty_documents/html
      - src/util/dirty_documents/other
      - src/util/dirty_documents/pdf
      - src/util/dirty_documents/temp
    When a new file is detected in any of the first four directories (and is not already
    in the temp directory), it is copied to `temp`, its path in temp is added to the internal queue,
    and then the original file is deleted.
    """
    def __init__(self, base_dir: str = os.path.join("src", "util", "dirty_documents"), max_queue_size: int = 1000):
        self.base_dir = base_dir
        # These directories will be watched for new files.
        self.source_subdirs = ["docx", "html", "other", "pdf"]
        # The temp directory is used to store new files (and avoid duplicates).
        self.temp_dir = os.path.join(self.base_dir, "temp")
        # Auto-create all expected subdirs (not just temp/) so the pipeline is
        # self-bootstrapping on a fresh named volume or clone. The original code
        # assumed html/pdf/docx/other already existed on disk, which broke on
        # first run against an empty rag-dirty-docs volume.
        for sub in self.source_subdirs + ["temp"]:
            os.makedirs(os.path.join(self.base_dir, sub), exist_ok=True)
        # Bounded queue to avoid unbounded memory usage.
        self.queue = Queue(maxsize=max_queue_size)

    def is_relevant(self, path: str) -> bool:
        norm_path = os.path.normpath(os.path.abspath(path))
        temp_dir_norm = os.path.normpath(os.path.abspath(self.temp_dir))
        if norm_path.startswith(temp_dir_norm):
            return False
        for sub in self.source_subdirs:
            sub_dir = os.path.normpath(os.path.abspath(os.path.join(self.base_dir, sub)))
            if norm_path.startswith(sub_dir):
                return True
        return False

    def scan_directories(self):
        for sub in self.source_subdirs:
            sub_dir = os.path.join(self.base_dir, sub)
            if not os.path.isdir(sub_dir):
                logger.warning(f"Source directory does not exist: {sub_dir}")
                continue
            try:
                for file_name in os.listdir(sub_dir):
                    file_path = os.path.join(sub_dir, file_name)
                    if os.path.isfile(file_path):
                        # Ensure the filename carries a UUID4. Filenames that
                        # already have one are kept verbatim (user is opting
                        # into appending to that existing collection). Others
                        # get a fresh UUID, meaning a new collection will be
                        # created downstream. The UUID is then discoverable in
                        # every artifact the cleaner produces, without needing
                        # side-channel metadata.
                        tagged_name = tag_filename_with_uuid(file_name)
                        dest_path = os.path.join(self.temp_dir, tagged_name)
                        if os.path.exists(dest_path):
                            continue
                        try:
                            shutil.copy2(file_path, dest_path)
                            if tagged_name != file_name:
                                logger.info(
                                    f"Copied '{file_path}' to temp as '{dest_path}' "
                                    f"(auto-tagged with new UUID for a new vector store)"
                                )
                            else:
                                logger.info(
                                    f"Copied '{file_path}' to temp as '{dest_path}' "
                                    f"(UUID already present — will append to existing vector store)"
                                )
                            self.queue.put(dest_path)  # Will block if the queue is full.
                            try:
                                os.remove(file_path)
                                logger.info(f"Deleted original file '{file_path}'")
                            except Exception as del_err:
                                logger.error(f"Error deleting original file '{file_path}': {del_err}")
                        except Exception as e:
                            logger.error(f"Error copying '{file_path}' to temp: {e}")
            except Exception as e:
                logger.error(f"Error scanning directory '{sub_dir}': {e}")

    def run(self):
        logger.info("Starting directory monitoring using watchfiles...")
        for changes in watch(self.base_dir, recursive=True):
            if any(self.is_relevant(path) for _, path in changes):
                self.scan_directories()
