#!/usr/bin/env python3

import json
import sys
from pathlib import Path


try:
    import chromadb  # type: ignore
    CHROMADB_IMPORT_ERROR = None
except Exception as error:  # pragma: no cover - surfaced in runtime response
    chromadb = None
    CHROMADB_IMPORT_ERROR = error


_COLLECTION_CACHE = {}


def main() -> int:
    if len(sys.argv) > 1 and sys.argv[1] == "--server":
        return run_server()

    action = sys.argv[1] if len(sys.argv) > 1 else "status"
    payload = json.loads(sys.stdin.read() or "{}")
    response = execute_action(action, payload)
    print(json.dumps(response))
    return 0 if response.get("ok") else 1


def run_server() -> int:
    for raw_line in sys.stdin:
        line = raw_line.strip()
        if not line:
            continue

        request_id = None
        try:
            message = json.loads(line)
            request_id = message.get("id")
            response = execute_action(message.get("action", "status"), message.get("payload") or {})
        except Exception as error:  # pragma: no cover - defensive response path
            response = {"ok": False, "error": str(error)}

        if request_id is not None:
            response["id"] = request_id
        sys.stdout.write(f"{json.dumps(response)}\n")
        sys.stdout.flush()

    return 0


def execute_action(action: str, payload: dict) -> dict:
    if chromadb is None:
        return {
            "ok": False,
            "available": False,
            "python": sys.version,
            "error": f"chromadb is unavailable: {CHROMADB_IMPORT_ERROR}",
        }

    collection = get_collection(payload)

    if action == "status":
        return {
            "ok": True,
            "available": True,
            "python": sys.version,
            "collectionName": payload["collectionName"],
            "path": str(Path(payload["path"]).resolve()),
            "count": collection.count(),
        }

    if action == "ensure_collection":
        return {"ok": True, "count": collection.count()}

    if action == "upsert":
        collection.upsert(
            ids=payload["ids"],
            documents=payload["documents"],
            embeddings=payload["embeddings"],
            metadatas=payload["metadatas"],
        )
        return {"ok": True, "upsertedCount": len(payload["ids"])}

    if action == "query":
        results = collection.query(
            query_embeddings=[payload["queryEmbedding"]],
            n_results=payload.get("topK", 6),
            where=payload.get("where"),
            include=["documents", "metadatas", "distances"],
        )
        flattened = []
        ids = results.get("ids", [[]])[0]
        documents = results.get("documents", [[]])[0]
        metadatas = results.get("metadatas", [[]])[0]
        distances = results.get("distances", [[]])[0]
        for index, item_id in enumerate(ids):
            flattened.append(
                {
                    "id": item_id,
                    "document": documents[index] if index < len(documents) else "",
                    "metadata": metadatas[index] if index < len(metadatas) else {},
                    "distance": distances[index] if index < len(distances) else 1,
                }
            )
        return {"ok": True, "results": flattened}

    if action == "delete_ids":
        ids = payload.get("ids", [])
        if ids:
            collection.delete(ids=ids)
        return {"ok": True, "deletedCount": len(ids)}

    return {"ok": False, "error": f"Unknown action: {action}"}


def get_collection(payload: dict):
    cache_key = (payload["path"], payload["collectionName"])
    cached = _COLLECTION_CACHE.get(cache_key)
    if cached is not None:
        return cached

    client = chromadb.PersistentClient(path=payload["path"])
    collection = client.get_or_create_collection(
        name=payload["collectionName"],
        metadata={"hnsw:space": "cosine"},
    )
    _COLLECTION_CACHE[cache_key] = collection
    return collection


if __name__ == "__main__":
    raise SystemExit(main())