
import csv
import json
import os
import difflib

CSV_FILE = "Insurance_plan_dataset.csv"
OUTPUT_FILE = "plan_scores.json"

def calculate_scores():
    if not os.path.exists(CSV_FILE):
        print(f"Error: {CSV_FILE} not found.")
        return

    scores_data = {}
    
    with open(CSV_FILE, 'r', encoding='utf-8') as f:
        reader = csv.DictReader(f)
        headers = reader.fieldnames
        skip_cols = ['Sr No', 'Insurance Company', 'Base Plan Name']
        feature_cols = [h for h in headers if h not in skip_cols and h]
        
        total_features = len(feature_cols)
        print(f"Total Feature Columns: {total_features}")
        
        # Negative Keywords
        negative_values = ["not available", "not covered", "not applicable", "na", "-", "no coverage", "not included", "not inbuilt"]

        for row in reader:
            company = row.get('Insurance Company', 'Unknown').strip()
            plan_name = row.get('Base Plan Name', 'Unknown').strip()
            
            total_quality_points = 0.0
            
            for col in feature_cols:
                val = row.get(col, "").strip().lower()
                
                # Quality Score (0.0 to 1.0)
                quality_score = 1.0 # Default to Perfect if present
                
                # 1. Negative Check
                if not val or val in negative_values:
                    quality_score = 0.0
                elif val.startswith("no ") and "room" not in col.lower() and "sub-limit" not in col.lower():
                     quality_score = 0.0

                # 2. Quality Adjustments (User requested max 1.0)
                if quality_score > 0:
                    # A. Sub-limits
                    if "sub-limits" in col.lower():
                        if "capped" in val or "limit" in val:
                            quality_score = 0.5 # Penalize caps
                            
                    # B. Room Rent
                    elif "room rent" in col.lower() or "room" in col.lower():
                        if "single" in val:
                            quality_score = 0.8 # Mild restriction
                        elif "shared" in val or "capped" in val:
                            quality_score = 0.5 # Heavy restriction
                            
                    # C. Restoration / Bonus
                    elif "restoration" in col.lower() or "bonus" in col.lower():
                        # Standard is 1.0. If capped low, reduce?
                        if "10%" in val or "20%" in val:
                            quality_score = 0.7 # Lower quality bonus
                        elif "50%" in val:
                            quality_score = 0.9

                    # Add to total
                    total_quality_points += quality_score
            
            # Simple Average Calculation
            # (Sum of Quality Scores / Total Features) * 10
            final_score = (total_quality_points / total_features) * 10
            
            key = f"{plan_name.lower().strip()}|{company.lower().strip()}"
            scores_data[key] = {
                "score": round(final_score, 2),
                "positives": round(total_quality_points, 1), # This matches "Sum of scores"
                "total": total_features,
                "company": company,
                "plan_name": plan_name
            }

            # Debug specific plans
            if "elevate (basic)" in key or "optima restore" in key:
                 print(f"{plan_name}: Quality Sum={total_quality_points:.2f}/{total_features} -> {final_score:.2f}")

    with open(OUTPUT_FILE, 'w', encoding='utf-8') as f:
        json.dump(scores_data, f, indent=4)
        
    print(f"Saved quality-based scores for {len(scores_data)} plans.")

if __name__ == "__main__":
    calculate_scores()
