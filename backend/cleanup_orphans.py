import os
import argparse
from dotenv import load_dotenv
from supabase import create_client

def main():
    parser = argparse.ArgumentParser(description="Cleanup orphaned PDF files in Supabase Storage.")
    parser.add_argument("--delete", action="store_true", help="Delete the found orphaned files instead of just listing them.")
    args = parser.parse_args()

    load_dotenv(override=True)
    url = os.getenv("SUPABASE_URL")
    key = os.getenv("SUPABASE_KEY")

    if not url or not key:
        print("Missing Supabase credentials in .env")
        return

    client = create_client(url, key)

    print("Checking for orphaned PDFs (files in Storage bucket 'policy_pdfs' but NOT in 'policy_analyses' table)...")

    # 1. Get all files from Storage
    storage_files = []
    try:
        top_items = client.storage.from_("policy_pdfs").list()
        for item in top_items:
            name = item.get("name")
            if not name: continue
            
            # List items in user folder
            user_files = client.storage.from_("policy_pdfs").list(name)
            for uf in user_files:
                f_name = uf.get("name")
                if f_name and f_name != ".emptyFolderPlaceholder":
                    storage_files.append(f"{name}/{f_name}")
    except Exception as e:
        print(f"Error listing storage: {e}")
        return

    # 2. Get all files from DB
    db_paths = set()
    try:
        res = client.table("policy_analyses").select("pdf_file_url").execute()
        if res.data:
            for row in res.data:
                u = row.get("pdf_file_url")
                if u and "/public/policy_pdfs/" in u:
                    path = u.split("/public/policy_pdfs/")[1]
                    db_paths.add(path)
    except Exception as e:
        print(f"Error querying DB: {e}")
        return

    # 3. Find Orphans
    orphans = [f for f in storage_files if f not in db_paths]

    print(f"\nFiles in Storage: {len(storage_files)}")
    print(f"Files referenced in DB: {len(db_paths)}")
    print(f"Orphaned Files Found: {len(orphans)}")

    if not orphans:
        print("\nNo orphaned files found.")
        return

    print("\nOrphaned Files:")
    for o in orphans:
        print(f"- {o}")

    if args.delete:
        print(f"\nAttempting to delete {len(orphans)} orphaned files...")
        try:
            client.storage.from_("policy_pdfs").remove(orphans)
            print("✅ Successfully deleted orphaned files from storage.")
        except Exception as e:
            print(f"❌ Error deleting files: {e}")
    else:
        print("\n💡 Run with '--delete' flag to automatically remove these files.")

if __name__ == "__main__":
    main()
