// Populate the minimum env surface required by src/env.ts so that modules
// which transitively import it (logger, bus, stream) don't exit the test
// runner at module-evaluation time. These are test-only fakes; real values
// are supplied by the actual .env at runtime.
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "silent";
process.env.SHARED_RUNBOOKS_UUID ??= "d96b439c-5e3d-4e25-9790-f2235ffffe26";
process.env.SHARED_SKILLS_UUID ??= "08de373f-ca2d-4e49-8ca9-5ff799ae5d40";
process.env.SHARED_SELECTORS_UUID ??= "c6cc431a-941c-4ff4-8003-55f24dcc1e4b";
process.env.PG_URL ??= "postgres://agent:agent@localhost:5432/agent_test";
process.env.RAG_URL ??= "http://rag:3009";
process.env.QDRANT_URL ??= "http://qdrant:6333";
