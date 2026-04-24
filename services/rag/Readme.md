# docs_pipeline_311 Project Setup

This repository contains the code for the docs_pipeline_311 project. This document provides detailed instructions for setting up a local development environment and for running the application in a Docker container with GPU access on a cloud instance.

---

## Table of Contents

- [Local Development Setup](#local-development-setup)
  - [Prerequisites](#prerequisites)
  - [Creating and Activating the Virtual Environment](#creating-and-activating-the-virtual-environment)
  - [Installing Dependencies](#installing-dependencies)
- [Usage](#usage)
- [Troubleshooting and Additional Notes](#troubleshooting-and-additional-notes)

---

## Local Development Setup

### Prerequisites
- **Python 3.11 installed on your system.
- A working terminal or command prompt.

### Install Dependencies

0. Ensure you have clone the repository
1. Install Docker Desktop (if not already installed)
2. Pull the vector database Qdrant from Docker and familiarize ourselves with Qdrant using Qdrant's introduction

### Setting up Qdrant vector database

1. **Install Docker Desktop**
   You can find it here: https://docs.docker.com/desktop/

2. **Pull and run Qdrant using Docker:**
   ```bash
   docker run -d \
     --name qdrant \
     -p 6333:6333 \
     -e QDRANT__SERVICE__GRPC_ENABLE=true \
     qdrant/qdrant:latest
   ```

3. **Access the Qdrant dashboard:**
   Open your browser and navigate to:
   ```
   http://localhost:6333/dashboard#/collections
   ```
   Ensure you are ready and prepared to use Qdrant by following their guided introduction.

### Creating and Activating the Virtual Environment

1. **Navigate to the project directory:**
   ```bash
   cd ~/De/G/Embedding_Pipline/docs_pipeline_311
   ```

2. **Create a virtual environment named pipeline_311:**
   ```bash
   python3.11 -m venv pipeline_311 
   ```

3. **Activate the virtual environment:**

   On macOS/Linux:
   ```bash
   source pipeline_311/bin/activate
   ```

   On Windows:
   ```bash
   pipeline_311\Scripts\activate
   ```

4. **Update pip and install dependencies:**
   ```bash
   pip install --upgrade pip
   pip install -r requirements.txt
   ```

5. **Run the main application:**
   ```bash
   python main.py
   ```

   Wait for the code to start-up. It can take a few seconds because of multithreading and healthchecks. You should see something like this:
   ```
   INFO:httpx:HTTP Request: GET http://localhost:6333 "HTTP/1.1 200 OK"
   INFO:__main__:Starting main application...
   INFO:src.util.queue:Starting directory monitoring using watchfiles...
   INFO:__main__:Started FileQueue monitoring for dirty documents.
   INFO:src.util.clean_doc_queue:Starting monitoring for clean documents...
   INFO:__main__:Started CleanDocQueue monitoring for clean documents.
   INFO:src.util.document_cleaning_pipline:Loading spaCy model for ESG/PAS extraction: en_core_web_trf
   INFO:__main__:Document cleaning consumer Thread-3 (consumer_worker) started.
   INFO:__main__:Document cleaning consumer Thread-4 (consumer_worker) started.
   INFO:__main__:Started 2 cleaning consumer threads.
   INFO:__main__:Started document cleaning scaling monitor.
   INFO:initializers:Warming up embedding model: guymorganb/e5-large-v2-4096-lsg-patched...
   ```

**IMPORTANT:** main.py must be running while you simultaneously run the configurator.py in another terminal.

## Running the configurator.py to test cosine similarity search

### High level overview of what we must accomplish:
a. Ensure the config.yml has: `agent.embedding_model.will_embed_docs: true`
b. Select a document (pdf, docx and html are currently supported)
c. Move the document into docs_pipeline_311/src/util/dirty_documents/pdf (if it is a .pdf) or move it to the appropriate directory that matches the file extension
d. Start the configurator.py while the main.py is already running

**NOTE:** During this process the query model may be downloaded from Hugging Face if you don't have it locally

### Preparing and processing documents

1. **Ensure the config.yml has:**
   ```
   agent.embedding_model.will_embed_docs: true
   ```

2. **Select a document** (pdf, docx, tsv and html are currently supported)

3. **Move the document** into the appropriate directory:
   - PDF files: `docs_pipeline_311/src/util/dirty_documents/pdf/`
   - Match other file types to their respective directories

**NOTE:** AVOID MULTIPLE DOCUMENTS AT ONCE & LARGE DOCUMENTS WITHOUT GPU SUPPORT, unless you intend to wait for a long time. The pipeline has been tested on multiple texts simultaneously that are thousands of pages long. The pattern is efficient and processes well. The MCATS series of textbooks was the target subject.

4. **On successful embedding** you should see something like this:
   ```
   INFO:src.vector_store.qdrant_config:[QdrantManager] Done upserting all 32 points to 'document_vectors'.
   INFO:src.model.embedding_model:[✨] Upserted 32 chunks into 'document_vectors'.
   Embedding ingestion complete.
   ```

### Querying the vector store

1. **Open a new terminal** and navigate to the project's root directory
   
2. **Activate the virtual environment:**

   On macOS/Linux:
   ```bash
   source pipeline_311/bin/activate
   ```

   On Windows:
   ```bash
   pipeline_311\Scripts\activate
   ```

3. **Run the configurator:**
   ```bash
   python configurator.py
   ```

4. **You should see this menu:**
   ```
   ? Select an action: (Use arrow keys)
      Update Configuration
      Test Embedding Model
    » Test Query Model
      Exit
   ```

5. **Select "Test Query Model" and the model will be warmed up:**
   ```
   === Test Query Model ===

   INFO:src.hugging_face_query:Initializing HuggingFaceQuery: guymorganb/e5-large-v2-4096-lsg-patched on device mps
   INFO:src.model.query_model:Initialized QueryModel with model_name=guymorganb/e5-large-v2-4096-lsg-patched, device=mps, max_length=4096, top_k=5, batch_size=8
   INFO:src.model.query_model:Warming up the query model with a trivial query embedding...
   INFO:src.model.query_model:Query model warm-up complete.
   ? Select a query type: (Use arrow keys)
    » QA Search
      Deep Semantic Search
      Exit to main menu
   ```

6. **Select a query type and ask a question:**
   ```
   ? Select a query type: Deep Semantic Search
   ? Enter your query (type 'quit' to exit): How does Watson use type coercion in question answering?
   INFO:httpx:HTTP Request: POST http://localhost:6333/collections/document_vectors/points/search "HTTP/1.1 200 OK"

   === Search Results ===
   [1] [SCORE: 0.8376] passage: Typing candidate answers using type coercion J. W. Murdock D. A. Ferrucci D. C. Gondek Many questions explicitly indicate the type of answer required. One popular approach to answering those questions is to develop recognizers to identify instances of common answer types (e.g., countries, animals, and food) and consider only answers on those lists. Such a strategy is poorly suited to answering questions from the Jeopardy!i television quiz show. Jeopardy! questions have an extremely broad range of types of answers, and the most frequently occurring types cover only a small fraction of all answers. We present an alternative approach to dealing with answer types. We generate candidate answers without regard to type, and for each candidate, we employ a variety of sources and strategies to judge whether the candidate has the desired type. These sources and strategies provide a set of type coercion scores for each candidate answer. We use these scores to give preference to answers with more evidence of having the right type. Our question-answering system is signiﬁcantly more accurate with type coercion than it is without type coercion; these components have a combined The Jeopardy!** question BIn 1902 Panama was still part of this country[ explicitly indicates that the correct answer is a country. To answer questions such as this one, it is important to be able to distinguish between candidate answers that are countries and those that are not. Many open-domain question-answering (QA) systems (e.g., [1–4]) adopt a type-and-generate approach by analyzing incoming questions for the expected answer type, mapping it into a ﬁxed set of known types, and restricting candidate answers retrieved from the corpus to those that match this answer type (using type-speciﬁc recognizers to identify the candidates). The type-and-generate approach suffers from several problems.
   [2] [SCORE: 0.8267] passage: Restricting the answer types to a ........
   ```