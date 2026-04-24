# RAG test fixtures

Sample HTML runbooks you can drag-and-drop into the `rag-dirty-docs` Docker volume to exercise the ingestion pipeline (clean → chunk → embed → upsert into Qdrant).

## Files

| File | Category | Purpose |
|---|---|---|
| `runbooks/password-reset.html` | `password_reset` | Agent workflow for resetting a user's password |
| `runbooks/unlock-account.html` | `account_unlock` | Agent workflow for unlocking a locked account |
| `runbooks/system-status-check.html` | `system_status` | Pre-escalation system health check |

## Collection-routing recap

Each file creates or appends to its own Qdrant collection named by the UUID4 in its filename:

- **No UUID in the name** (e.g. `password-reset.html`) → FileQueue auto-appends a fresh UUID → a **new** collection named with that UUID.
- **UUID already in the name** (e.g. `password-reset_<uuid>.html`) → FileQueue preserves the UUID → **appends** to the collection `<uuid>` (creates it if missing).
- Two files carrying the **same** UUID both land in that collection.

## Quick smoke: one untagged file → one new collection

```bash
# From the host, drop the password-reset runbook untagged.
docker run --rm \
  -v browser_agent_rag-dirty-docs:/dst \
  -v "$(pwd)/services/rag/test_fixtures/runbooks":/src \
  alpine sh -c 'cp /src/password-reset.html /dst/html/'

# Watch rag process it
docker compose logs -f --tail=30 rag
```

Success signals in the logs (collection name will be the UUID the queue auto-tagged):

```
src.util.queue: Copied '...password-reset.html' to temp as '.../password-reset_<uuid>.html'
                (auto-tagged with new UUID for a new vector store)
src.util.document_cleaning_pipline: Document processing complete.
src.vector_store.qdrant_config: Creating Qdrant collection: <uuid> with dimension=1024, distance=Cosine
src.vector_store.qdrant_config: [QdrantManager] Successfully upserted 1 points in 0.00 sec to '<uuid>'
src.model.embedding_model: [✨] Upserted 1 chunks into '<uuid>'.
Embedding ingestion complete.
```

## Concurrency smoke (6 files: 3 tagged + 3 untagged)

Verifies the UUID-in-filename routing, the append path, and the collection-creation race fix all at once.

Run from inside the `rag` container (so `$SHARED` stays set across the parallel copies):

```bash
docker exec -it rag bash
cd /app

bash -c '
SHARED=$(python3 -c "import uuid; print(uuid.uuid4())")
echo "SHARED=$SHARED"

# Three files tagged with SHARED -> append into one collection
cp test_fixtures/runbooks/password-reset.html      src/util/dirty_documents/html/pr_${SHARED}.html &
cp test_fixtures/runbooks/unlock-account.html      src/util/dirty_documents/html/ua_${SHARED}.html &
cp test_fixtures/runbooks/system-status-check.html src/util/dirty_documents/html/ss_${SHARED}.html &
# Three untagged copies -> three new collections (auto-UUID per file)
cp test_fixtures/runbooks/password-reset.html      src/util/dirty_documents/html/pr_copy.html &
cp test_fixtures/runbooks/unlock-account.html      src/util/dirty_documents/html/ua_copy.html &
cp test_fixtures/runbooks/system-status-check.html src/util/dirty_documents/html/ss_copy.html &
wait
'
```

Expected end state: **4 collections**, point counts `3 + 1 + 1 + 1` (the shared one has 3, each untagged one has 1).

## Verify collections

```bash
# List all collections + their point counts (run inside or outside the container)
for c in $(curl -s http://qdrant:6333/collections \
    | python3 -c "import sys,json; [print(c['name']) for c in json.load(sys.stdin)['result']['collections']]"); do
  n=$(curl -s http://qdrant:6333/collections/$c \
      | python3 -c "import sys,json; print(json.load(sys.stdin)['result']['points_count'])")
  printf "%-40s %s\n" "$c" "$n"
done
```

## Query a specific collection

```bash
# Substitute <UUID> with one of the collection names the previous command printed.
curl -s -X POST http://localhost:3009/docs/models/qa \
  -H 'content-type: application/json' \
  -d '{"query":"how do I reset a users password","collection_name":"<UUID>"}' \
  | python3 -m json.tool
```

The Qdrant dashboard at http://localhost:6333/dashboard is the most readable way to browse collections and inspect points.
