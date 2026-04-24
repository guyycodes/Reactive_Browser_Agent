import os
import re
import shutil
import uuid
import logging
import yaml
from datetime import datetime
from typing import List, Dict, Tuple

import spacy
from spacy.language import Language

# --- File Parsing Libraries ---
import fitz               # PyMuPDF (for PDF extraction)
import docx2txt           # For DOCX extraction
from bs4 import BeautifulSoup  # For HTML extraction

# --- PDF Creation ---
from fpdf import FPDF

logger = logging.getLogger(__name__)
logger.setLevel(logging.INFO)


class DocumentCleaner:
    """
    A class to process documents that are read from the queue.
    It:
      - Accepts a file path (from the queue),
      - Extracts raw text from the file (based on extension),
      - Cleans the text (basic cleaning, spaCy cleaning, and optional ESG/PAS extraction),
      - Chunks the cleaned text according to configuration,
      - Saves a PDF of the original extracted text,
      - Saves a PDF of the cleaned document (without ESG/PAS data),
      - Saves a separate PDF of the ESG/PAS extraction results,
      - Renames all resulting files with a UUID and a datetime stamp,
      - Moves them along with the renamed original file into a unique subdirectory.
    """

    def __init__(self, settings_path: str = "config.yml"):
        # Load settings from YAML.
        with open(settings_path, "r", encoding="utf-8") as f:
            self.settings = yaml.safe_load(f)

        # Configuration values.
        self.chunk_size: int = self.settings.get("text_splitter", {}).get("chunk_size", 300)
        self.chunk_overlap: int = self.settings.get("text_splitter", {}).get("chunk_overlap", 10)
        self.extract_esg: bool = self.settings.get("extract", {}).get("esg", True)
        self.extract_pas: bool = self.settings.get("extract", {}).get("pas", True)
        self.esg_pas_model: str = self.settings.get("esg_pas_model", "en_core_web_trf")
        
        # The directory where cleaned documents are saved.
        self.processed_output_dir: str = self.settings.get("processed_output_dir", "src/util/clean_docs")

        # Load spaCy model for ESG/PAS extraction.
        logger.info(f"Loading spaCy model for ESG/PAS extraction: {self.esg_pas_model}")
        # if spacy.prefer_gpu():
            # Disable GPU usage on MPS until support stabilizes:
            # Comment out or remove the following line to force CPU usage.
            # spacy.require_gpu()
        #     logger.info("GPU detected, but using CPU for spaCy to avoid MPS allocation issues.")
        # else:
        #     logger.info("GPU not available. Using CPU for spaCy.")
        self.nlp: Language = spacy.load(self.esg_pas_model)
        self.nlp.max_length = 5_000_000

        # Optional: fonts for PDF creation. Use default if not specified.
        self.fonts_to_register = self.settings.get("fonts", [])
        if not self.fonts_to_register:
            # Build an absolute path to the font file based on the current file's directory.
            default_font_path = os.path.abspath(
                os.path.join(os.path.dirname(__file__), "..", "fonts", "NotoSans-Regular.ttf")
            )
            default_font = {"name": "NotoSans", "path": default_font_path}
            self.fonts_to_register = [default_font]

        # Ensure the output directory exists.
        os.makedirs(self.processed_output_dir, exist_ok=True)

    # === FILE PARSING METHODS ===

    def extract_text_from_pdf(self, file_path: str) -> str:
        """Extract text from a PDF using PyMuPDF and log progress per page."""
        logger.info("Extracting text from PDF...")
        text = ""
        with open(file_path, "rb") as f:
            file_bytes = f.read()
        doc = fitz.open(stream=file_bytes, filetype="pdf")
        num_pages = doc.page_count
        for i, page in enumerate(doc):
            page_text = page.get_text()
            text += page_text
            logger.info(f"Processed page {i+1} of {num_pages}")
        return text

    def extract_text_from_docx(self, file_path: str) -> str:
        """Extract text from a DOCX file using docx2txt."""
        logger.info("Extracting text from DOCX...")
        return docx2txt.process(file_path)

    def extract_text_from_html(self, file_path: str) -> str:
        """Extract text from an HTML file using BeautifulSoup."""
        logger.info("Extracting text from HTML...")
        with open(file_path, "r", encoding="utf-8") as f:
            html_content = f.read()
        soup = BeautifulSoup(html_content, "html.parser")
        return soup.get_text(separator="\n")

    def extract_text_from_tsv(self, file_path: str) -> str:
        """Extract text from a TSV file. Joins columns with ' | '."""
        logger.info("Extracting text from TSV...")
        lines = []
        with open(file_path, "r", encoding="utf-8") as f:
            for line in f:
                stripped_line = line.strip()
                columns = stripped_line.split("\t")
                lines.append(" | ".join(columns))
        return "\n".join(lines)

    def extract_text_from_txt(self, file_path: str) -> str:
        """Read plain text from a file."""
        logger.info("Extracting text from TXT...")
        with open(file_path, "r", encoding="utf-8") as f:
            return f.read()

    def extract_text_from_file(self, file_path: str) -> str:
        """
        Determine file extension and extract text accordingly.
        Supported: .pdf, .docx/.doc, .html/.htm, .tsv; defaults to plain text.
        """
        ext = os.path.splitext(file_path)[1].lower()
        if ext == ".pdf":
            return self.extract_text_from_pdf(file_path)
        elif ext in [".docx", ".doc"]:
            return self.extract_text_from_docx(file_path)
        elif ext in [".html", ".htm"]:
            return self.extract_text_from_html(file_path)
        elif ext == ".tsv":
            return self.extract_text_from_tsv(file_path)
        else:
            return self.extract_text_from_txt(file_path)

    # === NEW: FOOTER FILTERING METHOD ===

    def remove_footer_info(self, text: str) -> str:
        """
        Removes common footer or citation text (e.g., copyright notices, DOIs,
        publisher info, trademarks, page numbering) that typically appear at the bottom
        of academic papers. This is done by filtering out lines that contain typical footer keywords,
        citation patterns, or that are very short and likely contain non-content data.
        """
        filtered_lines = []
        # A robust regex pattern to match various footer, citation, and trademark indicators.
        footer_pattern = re.compile(
            r"(©|copyright|DOI|10\.\d{4,9}/[-._;()/:A-Z0-9]+|IBM|digital object identifier|Additional metadata:|"
            r"Trademark,?\s*(service mark,?\s*or\s*registered trademark)?|vol\.\s*\d+|no\.\s*[\d/]+|Paper\s*\d+|pp\.\s*\d+|"
            r"^\d+\s*:\s*\d+)",
            re.IGNORECASE)
        for line in text.splitlines():
            line_stripped = line.strip()
            if footer_pattern.search(line_stripped):
                continue
            if len(line_stripped.split()) < 3:
                continue
            filtered_lines.append(line)
        return "\n".join(filtered_lines)

    # === TEXT CLEANING METHODS ===

    def basic_clean_text(self, text: str) -> str:
        """
        Basic cleaning: trim whitespace and collapse multiple spaces.
        """
        text = text.strip()
        text = re.sub(r"\s+", " ", text)
        return text

    def spacy_clean_text(self, text: str, nlp_pipeline: Language) -> str:
        """
        Use spaCy to further clean text:
          - Lowercase and lemmatize tokens,
          - Remove stopwords and punctuation.
        Returns the reconstructed string.
        """
        logger.info("Starting spaCy cleaning...")
        doc = nlp_pipeline(text)
        tokens = [
            token.lemma_.lower() for token in doc
            if not token.is_stop and not token.is_punct and token.text.strip()
        ]
        cleaned = " ".join(tokens)
        logger.info("Finished spaCy cleaning.")
        return cleaned

    def get_nlp_for_long_text(self, nlp_pipeline: Language, text: str) -> Language:
        """
        If text exceeds the pipeline’s max_length, create a lightweight spaCy pipeline
        (with just a sentencizer) that can process long texts.
        """
        if len(text) > nlp_pipeline.max_length:
            logger.warning(
                f"Text length ({len(text)}) exceeds spaCy's max_length ({nlp_pipeline.max_length}). "
                "Creating a custom NLP engine with increased max_length."
            )
            lang = nlp_pipeline.meta.get("lang", "en")
            new_nlp = spacy.blank(lang)
            new_nlp.max_length = len(text) + 1000
            new_nlp.add_pipe("sentencizer")
            return new_nlp
        else:
            return nlp_pipeline

    def extract_esg_pas(self, text: str, nlp_pipeline: Language) -> Tuple[List[Dict], List[Dict]]:
        """
        Perform ESG/PAS extraction using spaCy.
          - ESG: For each token, capture text, lemma, POS, dependency, head, and children.
          - PAS: For each verb, extract subjects and objects.
        Returns a tuple: (esg_slots, pas_structures).
        """
        logger.info("Starting ESG/PAS extraction...")
        doc = nlp_pipeline(text)
        esg_slots = []
        pas_structures = []
        for token in doc:
            esg_slots.append({
                "text": token.text,
                "lemma": token.lemma_,
                "pos": token.pos_,
                "dep": token.dep_,
                "head": token.head.text,
                "children": [child.text for child in token.children],
            })
            if token.pos_ == "VERB":
                subjects = [child.text for child in token.children if child.dep_ in ("nsubj", "nsubjpass")]
                objects = [child.text for child in token.children if child.dep_ in ("dobj", "attr", "prep", "pobj")]
                pas_structures.append({
                    "predicate": token.text,
                    "subjects": subjects,
                    "objects": objects,
                })
        logger.info("Finished ESG/PAS extraction.")
        return esg_slots, pas_structures

    def process_text_for_esg_pas(self, text: str, nlp_pipeline: Language, chunk_size: int) -> str:
        """
        Process the text for ESG/PAS extraction. For long texts, pre-chunk using a custom
        NLP pipeline with a sentencizer to avoid max_length errors. For each chunk, perform
        ESG/PAS extraction and return the combined extraction output.
        """
        safe_nlp = self.get_nlp_for_long_text(nlp_pipeline, text)
        pre_chunks = self.chunk_text(text, safe_nlp, max_words=chunk_size)
        processed_chunks = []
        total_chunks = len(pre_chunks)
        logger.info(f"Processing ESG/PAS extraction on {total_chunks} chunks...")
        for idx, chunk in enumerate(pre_chunks):
            try:
                esg_slots, pas_structures = self.extract_esg_pas(chunk, nlp_pipeline)
                extraction_info = "\nESG:\n" + "\n".join([str(slot) for slot in esg_slots]) \
                                  + "\nPAS:\n" + "\n".join([str(pas) for pas in pas_structures])
                processed_chunks.append(extraction_info)
                if (idx+1) % 5 == 0 or (idx+1) == total_chunks:
                    logger.info(f"Processed ESG/PAS for chunk {idx+1} of {total_chunks}")
            except Exception as e:
                logger.error(f"Error processing chunk during ESG/PAS extraction: {e}")
        return "\n".join(processed_chunks)
    
    # === CHUNK TEXT METHOD - our word-based chunker - (Migrated from text_utils.py) ===
    
    def chunk_text(self, text: str, nlp: Language, max_words: int = None, overlap: int = 10) -> List[str]:
        """
        Splits the input text into chunks of up to max_words words while preserving sentence
        boundaries when possible. If a single sentence is longer than max_words, it is further
        split using a sliding window with the specified overlap.
        
        Parameters:
          - text: the raw text to split.
          - nlp: a loaded spaCy model for sentence segmentation.
          - max_words: maximum number of words allowed per chunk (defaults to self.chunk_size).
          - overlap: number of words to overlap between chunks for very long sentences (defaults to self.chunk_overlap).
        
        Returns:
          A list of text chunks.
        """
        if max_words is None:
            max_words = self.chunk_size
        if overlap is None:
            overlap = self.chunk_overlap

        # Use spaCy to split the text into sentences.
        sentences = [sent.text.strip() for sent in nlp(text).sents if sent.text.strip()]
        chunks = []
        current_chunk_words = []

        for sentence in sentences:
            sentence_words = sentence.split()
            num_sentence_words = len(sentence_words)

            # If the sentence itself exceeds max_words, process it with a sliding window.
            if num_sentence_words > max_words:
                if current_chunk_words:
                    chunk_str = " ".join(current_chunk_words)
                    wc = len(chunk_str.split())
                    if wc <= max_words:
                        logger.info(f"Chunk passed (pre-flush): {wc} words")
                    else:
                        logger.error(f"Chunk failed (pre-flush): {wc} words exceed limit of {max_words}")
                    chunks.append(chunk_str)
                    current_chunk_words = []
                start = 0
                while start < num_sentence_words:
                    end = min(start + max_words, num_sentence_words)
                    subchunk = " ".join(sentence_words[start:end])
                    subchunk_wc = len(subchunk.split())
                    if subchunk_wc <= max_words:
                        logger.info(f"Subchunk passed: {subchunk_wc} words")
                    else:
                        logger.error(f"Subchunk failed: {subchunk_wc} words exceed limit of {max_words}")
                    chunks.append(subchunk)
                    if end == num_sentence_words:
                        break
                    start += (max_words - overlap)
            else:
                if len(current_chunk_words) + num_sentence_words <= max_words:
                    current_chunk_words.extend(sentence_words)
                else:
                    if current_chunk_words:
                        chunk_str = " ".join(current_chunk_words)
                        chunk_wc = len(chunk_str.split())
                        if chunk_wc <= max_words:
                            logger.info(f"Chunk passed: {chunk_wc} words")
                        else:
                            logger.error(f"Chunk failed: {chunk_wc} words exceed limit of {max_words}")
                        chunks.append(chunk_str)
                    current_chunk_words = sentence_words[:]
        
        if current_chunk_words:
            chunk_str = " ".join(current_chunk_words)
            chunk_wc = len(chunk_str.split())
            if chunk_wc <= max_words:
                logger.info(f"Final chunk passed: {chunk_wc} words")
            else:
                logger.error(f"Final chunk failed: {chunk_wc} words exceed limit of {max_words}")
            chunks.append(chunk_str)
        
        return chunks

    # === PDF SAVING METHOD ===

    def save_processed_pdf(self, chunks: List[str]) -> str:
        """
        Join the list of text chunks into a single PDF using Unicode fonts.
        The PDF is saved in the processed_output_dir.
        Returns the file path.
        """
        logger.info("Saving processed document as PDF...")
        file_name = f"temp_{uuid.uuid4().hex}.pdf"
        file_path = os.path.join(self.processed_output_dir, file_name)

        processed_text = "\n\n".join(chunks)
        pdf = UnicodeFPDF()
        pdf.set_auto_page_break(auto=True, margin=15)
        pdf.add_page()

        # Register custom fonts.
        for font in self.fonts_to_register:
            try:
                pdf.add_font(font["name"], "", font["path"], uni=True)
                logger.info(f"Registered font '{font['name']}' from {font['path']}")
            except Exception as e:
                logger.error(f"Error registering font {font['name']} from {font['path']}: {e}")

        default_font = self.fonts_to_register[0]["name"] if self.fonts_to_register else "Helvetica"
        pdf.set_font(default_font, size=12)
        pdf.multi_cell(0, 10, processed_text)
        pdf.output(file_path)

        logger.info(f"PDF saved at {file_path}")
        return file_path

    def split_text_by_period(self, text: str) -> List[str]:
        """
        Splits the input text into chunks delimited by sentence boundaries (periods)
        so that each chunk is at most self.chunk_size words. Additionally, whenever a bullet point
        (•) is encountered, a newline is forced to begin (ensuring bullet points start on a new line).
        Each resulting chunk is prefixed with "*$%pass:".
        If a single sentence exceeds self.chunk_size, it is broken into sub-chunks using a sliding window
        with the specified overlap.
        """
        # First, ensure that any bullet point starts on a new line.
        text = re.sub(r'\s*•\s*', '\n• ', text)
        # Split the text into sentences, keeping the ending punctuation.
        sentences = re.split(r'(?<=[.?!])\s+', text)
        all_chunks = []
        current_chunk_words = []
        current_count = 0

        for sentence in sentences:
            sentence = sentence.strip()
            if not sentence:
                continue
            sentence_words = sentence.split()
            num_sentence_words = len(sentence_words)

            if num_sentence_words > self.chunk_size:
                if current_chunk_words:
                    chunk_str = " ".join(current_chunk_words)
                    wc = len(chunk_str.split())
                    if wc <= self.chunk_size:
                        logger.info(f"Chunk (pre-flush) passed: {wc} words")
                    else:
                        logger.error(f"Chunk (pre-flush) failed: {wc} words exceed limit of {self.chunk_size}")
                    all_chunks.append(chunk_str)
                    current_chunk_words = []
                    current_count = 0
                overlap = min(self.chunk_overlap, self.chunk_size - 1)
                start = 0
                while start < num_sentence_words:
                    end = min(start + self.chunk_size, num_sentence_words)
                    subchunk = " ".join(sentence_words[start:end])
                    subchunk_wc = len(subchunk.split())
                    if subchunk_wc <= self.chunk_size:
                        logger.info(f"Subchunk passed: {subchunk_wc} words")
                    else:
                        logger.error(f"Subchunk failed: {subchunk_wc} words exceed limit of {self.chunk_size}")
                    all_chunks.append(subchunk)
                    if end == num_sentence_words:
                        break
                    start += (self.chunk_size - overlap)
            else:
                if current_count + num_sentence_words <= self.chunk_size:
                    current_chunk_words.extend(sentence_words)
                    current_count += num_sentence_words
                else:
                    if current_chunk_words:
                        chunk_str = " ".join(current_chunk_words)
                        chunk_wc = len(chunk_str.split())
                        if chunk_wc <= self.chunk_size:
                            logger.info(f"Chunk passed: {chunk_wc} words")
                        else:
                            logger.error(f"Chunk failed: {chunk_wc} words exceed limit of {self.chunk_size}")
                        all_chunks.append(chunk_str)
                    current_chunk_words = sentence_words.copy()
                    current_count = num_sentence_words

        if current_chunk_words:
            chunk_str = " ".join(current_chunk_words)
            chunk_wc = len(chunk_str.split())
            if chunk_wc <= self.chunk_size:
                logger.info(f"Final chunk passed: {chunk_wc} words")
            else:
                logger.error(f"Final chunk failed: {chunk_wc} words exceed limit of {self.chunk_size}")
            all_chunks.append(chunk_str)
        
        labeled_chunks = [f"*$%pass: {chunk}" for chunk in all_chunks]
        return labeled_chunks

    def split_orig_into_finished(self, orig_pdf_path: str, output_dir: str) -> str:
        """
        Extracts text from the provided orig_ PDF, splits it into chunks
        (using split_text_by_period), and writes the chunks to a file named
        'finished.txt' in the output directory (each chunk separated by a newline).
        Returns the path to the finished file.
        """
        logger.info("Extracting text for finished file from original PDF...")
        orig_text = self.extract_text_from_pdf(orig_pdf_path)
        orig_text = self.remove_footer_info(orig_text)
        chunks = self.split_text_by_period(orig_text)
        finished_text = "\n".join(chunks)
        finished_path = os.path.join(output_dir, "finished.txt")
        with open(finished_path, "w", encoding="utf-8") as f:
            f.write(finished_text)
        logger.info(f"Finished file created at: {finished_path}")
        return finished_path

    def process_document_from_queue(self, file_path: str) -> Dict:
        """
        Processes a single document given by file_path:
          1. Extract and basic-clean the raw text.
          2. Save a PDF of the original extracted text.
          3. Further clean the text (using spaCy) without ESG/PAS.
          4. Separately, run ESG/PAS extraction on the cleaned text.
          5. Chunk the cleaned text and save a PDF of the cleaned document.
          6. Chunk the ESG/PAS output and save a separate PDF.
          7. Create a unique subdirectory (using UUID and timestamp) in which:
               - The cleaned PDF,
               - The original PDF,
               - The ESG/PAS PDF (if available), and
               - The original file (renamed) are saved.
          8. Process the 'orig_' file (original extracted text PDF) to create a new file named 'finished.txt'
             that contains the text split into chunks (each ≤ 300 words, using periods as delimiters).
        
        Returns a dictionary with processing metadata.
        """
        logger.info(f"Started processing file from queue: {file_path}")
        try:
            # Step 1 & 2: Extract text, remove footer info, clean, and save the original PDF.
            logger.info("Extracting and cleaning original text...")
            original_text = self.extract_text_from_file(file_path)
            original_text = self.remove_footer_info(original_text)
            original_text = self.basic_clean_text(original_text)
            original_pdf_temp = self.save_processed_pdf([original_text])
            logger.info("Original text extracted and saved as PDF.")

            # Step 3: Further clean the text using spaCy.
            logger.info("Performing further cleaning using spaCy...")
            cleaned_text = self.spacy_clean_text(original_text, self.nlp)
            logger.info("Further cleaning completed.")

            # Step 4: Run ESG/PAS extraction (if enabled).
            if self.extract_esg or self.extract_pas:
                logger.info("Running ESG/PAS extraction on cleaned text...")
                esg_pas_text = self.process_text_for_esg_pas(cleaned_text, self.nlp, self.chunk_size)
                logger.info("ESG/PAS extraction completed.")
            else:
                esg_pas_text = ""

            # Step 5: Chunk the cleaned text and save the cleaned PDF.
            logger.info("Chunking cleaned text...")
            safe_nlp_clean = self.get_nlp_for_long_text(self.nlp, cleaned_text)
            chunks_cleaned = self.chunk_text(cleaned_text, safe_nlp_clean, max_words=self.chunk_size, overlap=self.chunk_overlap)
            logger.info(f"Cleaned text split into {len(chunks_cleaned)} chunks.")
            cleaned_pdf_temp = self.save_processed_pdf(chunks_cleaned)
            logger.info("Cleaned PDF saved.")

            # Step 6: If ESG/PAS text exists, chunk and save the ESG/PAS PDF.
            # if esg_pas_text:
            #     logger.info("Chunking ESG/PAS text...")
            #     safe_nlp_esg = self.get_nlp_for_long_text(self.nlp, esg_pas_text)
            #     chunks_esg = self.chunk_text(esg_pas_text, safe_nlp_esg, max_words=self.chunk_size, overlap=self.chunk_overlap)
            #     logger.info(f"ESG/PAS text split into {len(chunks_esg)} chunks.")
            #     esg_pas_pdf_temp = self.save_processed_pdf(chunks_esg)
            #     logger.info("ESG/PAS PDF saved.")
            # else:
            #     esg_pas_pdf_temp = None

            # Step 7: Create a unique output directory.
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            unique_dir_name = f"{uuid.uuid4().hex}_{timestamp}"
            unique_dir_path = os.path.join(self.processed_output_dir, unique_dir_name)
            os.makedirs(unique_dir_path, exist_ok=True)
            logger.info(f"Created unique output directory: {unique_dir_path}")

            # Move the cleaned PDF.
            # Use shutil.move instead of os.rename so cross-filesystem moves work
            # (required when dirty_documents and clean_docs are on separate Docker
            # named volumes, which are distinct filesystems).
            new_cleaned_filename = f"clean_{timestamp}.pdf"
            new_cleaned_path = os.path.join(unique_dir_path, new_cleaned_filename)
            shutil.move(cleaned_pdf_temp, new_cleaned_path)
            logger.info(f"Moved cleaned PDF to: {new_cleaned_path}")

            original_basename, original_ext = os.path.splitext(os.path.basename(file_path))
            new_original_filename = f"{original_basename}_{timestamp}{original_ext}"
            new_original_path = os.path.join(unique_dir_path, new_original_filename)
            shutil.move(file_path, new_original_path)
            logger.info(f"Moved and renamed original file to: {new_original_path}")

            new_original_pdf_filename = f"orig_{timestamp}.pdf"
            new_original_pdf_path = os.path.join(unique_dir_path, new_original_pdf_filename)
            shutil.move(original_pdf_temp, new_original_pdf_path)
            logger.info(f"Moved original PDF to: {new_original_pdf_path}")

            # Step 8: Process the 'orig_' file (original PDF) to create the finished file.
            logger.info("Processing original PDF to create finished.txt file...")
            finished_file_path = self.split_orig_into_finished(new_original_pdf_path, unique_dir_path)
            logger.info(f"Created finished file: {finished_file_path}")

            logger.info("Document processing complete.")
            return {
                "chunk_count_cleaned": len(chunks_cleaned),
                # "chunk_count_esg": len(chunks_esg) if esg_pas_text else 0,
                "original_pdf": new_original_pdf_path,
                "cleaned_pdf": new_cleaned_path,
                # "esg_pas_pdf": new_esg_pas_path,
                "finished_file": finished_file_path,
                "renamed_original": new_original_path,
                "status": "complete",
                "output_folder": unique_dir_path
            }
        except Exception as e:
            logger.error(f"Error processing file {file_path}: {e}")
            return {
                "status": f"failed: {e}"
            }


# --- PDF Subclass for Unicode Support ---
class UnicodeFPDF(FPDF):
    """
    Subclass of FPDF to handle Unicode fonts.
    Customize further if needed.
    """
    pass
