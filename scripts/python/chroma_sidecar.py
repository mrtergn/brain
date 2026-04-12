#!/usr/bin/env python3

import json
import sys
from pathlib import Path


def main() -> int:
    action = sys.argv[1] if len(sys.argv) > 1 else "status"
    payload = json.loads(sys.stdin.read() or "{}")

    try:
        import chromadb  # type: ignore
    except Exception as error:
        response = {
            "ok": False,
            "available": False,
            "python": sys.version,
            "error": f"chromadb is unavailable: {error}",
        }
        print(json.dumps(response))
        return 0 if action == "status" else 1

    client = chromadb.PersistentClient(path=payload["path"])
    collection = client.get_or_create_collection(
        name=payload["collectionName"],
        metadata={"hnsw:space": "cosine"},
    )

    if action == "status":
        response = {
            "ok": True,
            "available": True,
            "python": sys.version,
            "collectionName": payload["collectionName"],
            "path": str(Path(payload["path"]).resolve()),
            "count": collection.count(),
        }
        print(json.dumps(response))
        return 0

    if action == "ensure_collection":
        print(json.dumps({"ok": True, "count": collection.count()}))
        return 0

    if action == "upsert":
        collection.upsert(
            ids=payload["ids"],
            documents=payload["documents"],
            embeddings=payload["embeddings"],
            metadatas=payload["metadatas"],
        )
        print(json.dumps({"ok": True, "upsertedCount": len(payload["ids"])}))
        return 0

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
        print(json.dumps({"ok": True, "results": flattened}))
        return 0

    if action == "delete_ids":
        ids = payload.get("ids", [])
        if ids:
            collection.delete(ids=ids)
        print(json.dumps({"ok": True, "deletedCount": len(ids)}))
        return 0

    print(json.dumps({"ok": False, "error": f"Unknown action: {action}"}))
    return 1


if __name__ == "__main__":
    raise SystemExit(main())