import os
import sys
sys.stdout.reconfigure(encoding='utf-8')
import uuid
import time
import urllib.parse
import urllib.request
import json
import csv
from datetime import datetime
from functools import lru_cache
from pathlib import Path
from fastapi import FastAPI, UploadFile, File, HTTPException, Depends, Header, status
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials

from fastapi.middleware.cors import CORSMiddleware
from fastapi.concurrency import run_in_threadpool
from dotenv import load_dotenv
import jwt  # PyJWT
from jwt import PyJWKClient
from google import genai
from google.genai import types
import asyncio
import io
import difflib
import filetype
from supabase import create_client, Client
from pydantic import BaseModel, Field
from typing import List, Dict

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(dotenv_path=BASE_DIR / ".env", override=False)
os.chdir(BASE_DIR)

# ── Cognito JWT validation ────────────────────────────────────────────────────
AWS_REGION = os.getenv("COGNITO_REGION") or os.getenv("AWS_REGION", "us-east-1")
COGNITO_USER_POOL_ID = os.getenv("COGNITO_USER_POOL_ID", "")
COGNITO_CLIENT_ID = os.getenv("COGNITO_CLIENT_ID", "")

_COGNITO_ISSUER = f"https://cognito-idp.{AWS_REGION}.amazonaws.com/{COGNITO_USER_POOL_ID}"
_JWKS_URI = f"{_COGNITO_ISSUER}/.well-known/jwks.json"

def _is_placeholder(value: str) -> bool:
    normalized = (value or "").strip().lower()
    return (
        not normalized
        or "your-" in normalized
        or "xxxxx" in normalized
        or normalized in {"change-me", "todo", "placeholder"}
    )

def _require_cognito_config():
    missing = []
    if _is_placeholder(AWS_REGION):
        missing.append("AWS_REGION")
    if _is_placeholder(COGNITO_USER_POOL_ID):
        missing.append("COGNITO_USER_POOL_ID")
    if _is_placeholder(COGNITO_CLIENT_ID):
        missing.append("COGNITO_CLIENT_ID")
    if missing:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=(
                "Backend Cognito auth is not configured. Set "
                f"{', '.join(missing)} in backend/.env to match the auth service "
                "that issued the login token."
            ),
        )

@lru_cache(maxsize=1)
def _get_jwks_client():
    return PyJWKClient(_JWKS_URI, cache_keys=True)

_security = HTTPBearer(auto_error=False)

def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(_security),
):
    if not credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="No token provided")
    
    token = credentials.credentials
    
    try:
        _require_cognito_config()
        jwks_client = _get_jwks_client()
        signing_key = jwks_client.get_signing_key_from_jwt(token)
        payload = jwt.decode(
            token,
            signing_key.key,
            algorithms=["RS256"],
            issuer=_COGNITO_ISSUER,
            options={"verify_exp": True, "verify_aud": False},
        )
        token_use = payload.get("token_use")
        expected_client = COGNITO_CLIENT_ID
        if expected_client:
            if token_use == "access" and payload.get("client_id") != expected_client:
                raise jwt.InvalidAudienceError("Invalid Cognito access token client_id")
            if token_use == "id" and payload.get("aud") != expected_client:
                raise jwt.InvalidAudienceError("Invalid Cognito ID token audience")

        user_id = payload.get("sub")
        return {
            "sub": user_id,
            "user_id": user_id,
            "email": payload.get("email"),
            "username": payload.get("cognito:username"),
        }
    except jwt.ExpiredSignatureError:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Token expired")
    except jwt.InvalidTokenError as e:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=f"Invalid token: {str(e)}")
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=(
                "Token validation failed while fetching Cognito signing keys. "
                "Check AWS_REGION and COGNITO_USER_POOL_ID in backend/.env. "
                f"JWKS URL: {_JWKS_URI}. Error: {str(e)}"
            ),
        )

class ComponentSchema(BaseModel):
    label: str
    value: str

class SumInsuredSchema(BaseModel):
    total: str
    components: List[ComponentSchema]

class PolicyHolderSchema(BaseModel):
    name: str = Field(..., description="Extract the full name of the policy holder")
    dob: str
    age: str

class PolicyDetailsSchema(BaseModel):
    start_date: str
    vintage: str

class Pass1Schema(BaseModel):
    company: str
    plan: str
    add_ons: str
    premium: str
    coverage: str
    city: str
    pincode: str
    policy_details: PolicyDetailsSchema
    sum_insured: SumInsuredSchema
    policy_holders: List[PolicyHolderSchema]

class FeatureEvaluation(BaseModel):
    feature_name: str = Field(..., description="The exact standardized Term from the REFERENCE FEATURES LIST.")
    verbatim_quote: str = Field(..., description="Extract this FIRST, before determining the value. Quote the exact text from the document.")
    value: str = Field(..., description="The calculated value/status of the feature based on the quote.")

class Pass2Schema(BaseModel):
    features: List[FeatureEvaluation]
    comprehensive_findings: str

api_key = os.getenv("GEMINI_API_KEY")
if _is_placeholder(api_key):
    print(
        f"ERROR: GEMINI_API_KEY is not set. Add a real value to {BASE_DIR / '.env'} "
        "or export it before starting the backend.",
        file=sys.stderr,
    )
    sys.exit(1)

supabase_url = os.getenv("SUPABASE_URL")
supabase_key = os.getenv("SUPABASE_KEY") or os.getenv("SUPABASE_SERVICE_KEY")
if _is_placeholder(supabase_url) or _is_placeholder(supabase_key):
    print("WARNING: SUPABASE_URL or SUPABASE_KEY/SUPABASE_SERVICE_KEY is not set.")
    supabase_client: Client | None = None
else:
    supabase_client: Client = create_client(supabase_url, supabase_key)


client = genai.Client(api_key=api_key)
app = FastAPI()

# --- ASYNC JOB QUEUE ---
# Stores running/completed jobs in memory. Jobs expire after 30 minutes.
JOB_STORE: dict = {}

def _cleanup_old_jobs():
    """Remove jobs older than 30 minutes to prevent memory leaks."""
    cutoff = time.time() - 1800
    expired = [jid for jid, j in JOB_STORE.items() if j.get("created_at", 0) < cutoff]
    for jid in expired:
        JOB_STORE.pop(jid, None)

# --- LOAD PRE-CALCULATED PLAN SCORES & USPs & RAW CSV CONTENT ---
PLAN_SCORES_DATA = {}

PLAN_USP_DATA = {} # Restored for USP.csv
DATASET_COLUMNS = []

# Global CSV Content Strings (Loaded once to save I/O)
FEATURES_CSV_CONTENT = ""
TERMINOLOGIES_CSV_CONTENT = ""
COMPANY_RATIOS_CSV_CONTENT = ""
PLANS_DATABASE_CSV_CONTENT = ""
USP_CSV_CONTENT = ""

SYNONYM_MAP = {}  # feature_name -> list of alt terms

def build_synonym_map():
    global SYNONYM_MAP
    csv_file = "similar features different terminologies.csv"
    if os.path.exists(csv_file):
        try:
            with open(csv_file, "r", encoding="utf-8", errors="replace") as f:
                reader = csv.reader(f)
                next(reader, None)
                category_map = {}
                for row in reader:
                    if len(row) >= 2:
                        category = row[0].strip()
                        feature = row[1].strip()
                        if category.startswith("Category") and feature:
                            if category not in category_map:
                                category_map[category] = []
                            category_map[category].append(feature)
                for cat, features in category_map.items():
                    if len(features) > 1:
                        primary = features[0]
                        synonyms = features[1:]
                        SYNONYM_MAP[primary] = synonyms
        except Exception as e:
            print(f"WARNING: Failed to parse synonyms CSV: {e}")

    # Hard-coded insurance domain synonyms
    hardcoded = {
        "Consumables & Non-Payable Cover": [
            "claim protector", "safe guard", "safeguard+", "non-payable cover",
            "consumable cover", "list I II III IV"
        ],
        "Restoration Benefit": [
            "recharge benefit", "auto restore", "automatic reinstatement",
            "sum insured reinstatement", "super recharge", "m-iracle"
        ],
        "No Claim Bonus": [
            "ncb", "cumulative bonus", "no claim benefit", "bonus super",
            "super ncb", "health bonus", "booster benefit"
        ],
        "Inflation Protector": [
            "inflation shield", "sum insured protector", "annual enhancement",
            "sum insured safeguard", "care shield", "enhanced si"
        ],
        "Pre & Post Hospitalization": [
            "pre-hospitalisation", "post-hospitalisation", "pre hospital",
            "post hospital", "pre & post", "pre/post"
        ],
        "Infinite Care": [
            "unlimited cover", "no claim limit", "infinite cover", "limitless care",
            "unlimited sum insured"
        ],
        "Room Rent": [
            "room rent limit", "accommodation charges", "room charges",
            "room category", "hospital room"
        ],
        "ICU Charges": [
            "icu expenses", "intensive care", "critical care unit", "icu benefit"
        ],
        "In Patient Hospitalization": [
            "inpatient hospitalisation", "ipd", "in-patient expenses",
            "hospitalisation benefit"
        ],
        "Day Care Treatments": [
            "day care procedures", "daycare", "day care surgeries"
        ],
    }
    for key, syn_list in hardcoded.items():
        if key in SYNONYM_MAP:
            SYNONYM_MAP[key].extend(syn_list)
        else:
            SYNONYM_MAP[key] = syn_list

    # Format as clear instructions for the LLM
    instructions = []
    for feature, synonyms in SYNONYM_MAP.items():
        unique_syns = list(dict.fromkeys([s.lower() for s in synonyms]))
        if unique_syns:
            instructions.append(
                f"- \"{feature}\" is also known as: {', '.join(unique_syns).title()}"
            )
    return "\n".join(instructions)

COMPULSORY_FEATURES = set() # Standard features that MUST be covered
CURRENT_INFLATION_RATE = 7.0  # Used for Inflation Shield Calculation

try:
    if os.path.exists("plan_scores.json"):
        with open("plan_scores.json", "r", encoding="utf-8", errors="replace") as f:
            # Normalize keys to lowercase for easier lookup
            raw_data = json.load(f)
            for k, v in raw_data.items():
                PLAN_SCORES_DATA[k.lower().strip()] = v
        print(f"DEBUG: Loaded {len(PLAN_SCORES_DATA)} plan scores (Simple-Avg) successfully.")

    if os.path.exists("Insurance_plan_dataset.csv"):
        # Load raw content for AI context
        with open("Insurance_plan_dataset.csv", "r", encoding="utf-8", errors="replace") as f:
             PLANS_DATABASE_CSV_CONTENT = f.read()

        # Re-read for structured data parsing
        with open("Insurance_plan_dataset.csv", "r", encoding="utf-8", errors="replace") as f:
            reader = csv.reader(f)
            headers = next(reader)
            # Filter out non-feature columns
            skip_cols = ['Sr No', 'Insurance Company', 'Base Plan Name']
            DATASET_COLUMNS = [h.strip().lower() for h in headers if h not in skip_cols and h.strip()]

        print(f"DEBUG: Loaded {len(DATASET_COLUMNS)} dataset columns for whitelist.")
    else:
        print("WARNING: Insurance_plan_dataset.csv not found.")

    if os.path.exists("features4.csv"):
        with open("features4.csv", "r", encoding="utf-8", errors="replace") as f:
            FEATURES_CSV_CONTENT = f.read()
            print("DEBUG: Loaded features4.csv successfully.")
    else:
        print("WARNING: features4.csv not found.")

    # Load and build structured synonyms map
    TERMINOLOGIES_CSV_CONTENT = build_synonym_map()
    if TERMINOLOGIES_CSV_CONTENT:
        print("DEBUG: Built structured Synonym Map successfully.")
    else:
        print("WARNING: Synonym Map generation resulted in empty output.")

    if os.path.exists("company_performance_ratios.csv"):
        with open("company_performance_ratios.csv", "r", encoding="utf-8", errors="replace") as f:
            COMPANY_RATIOS_CSV_CONTENT = f.read()
    else:
        print("WARNING: company_performance_ratios.csv not found.")

    if os.path.exists("compulsory features.csv"):
        with open("compulsory features.csv", "r", encoding="utf-8", errors="replace") as f:
            reader = csv.DictReader(f)
            for row in reader:
                feat = row.get("Feature", "").strip()
                if feat:
                    COMPULSORY_FEATURES.add(feat)
            print(f"DEBUG: Loaded {len(COMPULSORY_FEATURES)} compulsory features.")
    else:
        print("WARNING: compulsory features.csv not found.")

    # --- RESTORED: Load USPs from USP.csv ---
    if os.path.exists("USP.csv"):
        with open("USP.csv", "r", encoding="utf-8", errors="replace") as f:
            USP_CSV_CONTENT = f.read() # Load raw content for AI context to avoid duplicate key issues
            
            # Also load dict for legacy lookups (if any)
            f.seek(0)
            reader = csv.DictReader(f)
            for row in reader:
                # USP.csv headers: Sr No, Insurance Company, Base Plan Name, Unique Selling Point (USP)
                p_name = row.get("Base Plan Name", "").strip().lower()
                company = row.get("Insurance Company", "").strip().lower()
                usp_text = row.get("Unique Selling Point (USP)", "").strip()
                if p_name and usp_text:
                    # Use composite key to avoid duplicates (e.g. "Premier Plan" exists in 2 companies)
                    unique_key = f"{p_name}|{company}"
                    if unique_key in PLAN_USP_DATA:
                        print(f"DEBUG: USP Collision ignored for key: {unique_key}")
                    PLAN_USP_DATA[unique_key] = usp_text
        print(f"DEBUG: Loaded {len(PLAN_USP_DATA)} Plan USPs from USP.csv.")
    else:
        print("WARNING: USP.csv not found.")

except Exception as e:
    print(f"WARNING: Failed to load auxiliary data: {e}")


# Security: Get allowed origins from environment, default to localhost for development
allowed_origins = os.getenv("ALLOWED_ORIGINS", "http://localhost:5173,http://localhost:3000,http://127.0.0.1:5173").split(",")

app.add_middleware(
    CORSMiddleware,
    allow_origins=[origin.strip() for origin in allowed_origins if origin.strip()],
    allow_credentials=True, # Allow credentials for robust auth flows
    allow_methods=["*"],
    allow_headers=["*"],
)

# Security: Set max upload limit (default 10MB)
MAX_UPLOAD_SIZE_BYTES = int(os.getenv("MAX_UPLOAD_SIZE", 10 * 1024 * 1024))


# Using models discovered via check_models.py (Prioritizing stable models for structured schema capabilities)
PASS1_MODELS = [
    "gemini-2.5-flash",
    "gemini-2.0-flash",
    "gemini-1.5-flash"
]

PASS2_MODELS = [
    "gemini-2.5-pro",
    "gemini-2.5-flash",
    "gemini-1.5-pro"
]

# Legacy compatibility
MODEL_CANDIDATES = PASS1_MODELS

# City Tier Configuration
TIER_1_CITIES = [
    "mumbai", "delhi", "bangalore", "bengaluru", "hyderabad", "chennai", "kolkata", 
    "pune", "ahmedabad", "gurgaon", "gurugram", "noida"
]

# Blacklisted Companies (User Request)
BLACKLISTED_COMPANIES = ["niva bupa", "care health", "star health"]

# Financial Constants
CURRENT_INFLATION_RATE = 7.0 # 7% Annual Inflation calculation for Shield



TIER_1_HIGH_CITIES = ["mumbai", "delhi", "bangalore", "bengaluru"]
TIER_1_MID_CITIES  = ["hyderabad", "chennai", "kolkata", "pune", "ahmedabad",
                       "gurgaon", "gurugram", "noida"]

def analyze_user_profile(extracted_data):
    profile = {
        "city_tier": "Tier 2/3",
        "recommended_si_range": "₹10L – ₹25L",
        "recommended_min_si": "10 Lakhs",
        "healthcare_cost_level": "Moderate",
        "life_stage": "Individual",
        "family_type": "Individual"
    }

    city = extracted_data.get("city", "").lower().strip()
    if any(c in city for c in TIER_1_HIGH_CITIES):
        profile.update({
            "city_tier": "Tier 1 Premium Metro",
            "recommended_si_range": "₹50L – ₹1Cr",
            "recommended_min_si": "50 Lakhs",
            "healthcare_cost_level": "Very High"
        })
    elif any(c in city for c in TIER_1_MID_CITIES):
        profile.update({
            "city_tier": "Tier 1 Metro",
            "recommended_si_range": "₹25L – ₹50L",
            "recommended_min_si": "25 Lakhs",
            "healthcare_cost_level": "High"
        })

    policy_type = extracted_data.get("coverage", "").lower()
    members = extracted_data.get("policy_holders", [])
    if "floater" in policy_type or len(members) > 1:
        profile["family_type"] = "Floater / Family"
        profile["life_stage"] = "Family"

    ages = []
    for p in members:
        try:
            ages.append(int(p.get("age", 0)))
        except:
            pass

    max_age = max(ages) if ages else 30
    has_medical_history = extracted_data.get("has_medical_history", False)

    has_senior      = any(a >= 60 for a in ages)
    has_middle_aged = any(50 <= a < 60 for a in ages)
    has_child       = any(a <= 18 for a in ages)
    has_young_adult = any(18 < a < 35 for a in ages)
    needs_maternity = any(20 <= a <= 38 for a in ages)
    multi_gen       = (has_senior or has_middle_aged) and (has_child or has_young_adult)

    profile["family_flags"] = {
        "has_senior": has_senior,
        "has_middle_aged": has_middle_aged,
        "has_child": has_child,
        "has_young_adult": has_young_adult,
        "needs_maternity": needs_maternity,
        "multi_generation": multi_gen,
    }

    if max_age > 55 and has_medical_history:
        profile["age_group"] = "Senior WITH Medical History (CRITICAL: Suggest separate targeted plan emphasizing Day-1 PED cover)"
    elif max_age < 35:
        profile["age_group"] = "Young Adult (Prioritize: Low Premium, Wellness, Lock-in Age)"
    elif max_age < 50:
        profile["age_group"] = "Mid-Life (Prioritize: Comprehensive features, Maternity if relevant)"
    else:
        profile["age_group"] = "Senior (Prioritize: No Co-pay, Short Wait Periods, PED Cover)"

    priority = []
    if has_senior or has_middle_aged:
        priority += ["PED Cover", "No Co-pay", "No Room Rent Cap"]
    if has_child:
        priority += ["Restoration Benefit", "Day Care Treatments"]
    if needs_maternity:
        priority += ["Maternity Cover", "Newborn Cover"]
    if has_young_adult and not has_senior:
        priority += ["No Claim Bonus", "Wellness Benefits", "Age Lock"]
    if profile["city_tier"] in ["Tier 1 Premium Metro", "Tier 1 Metro"]:
        priority += ["Inflation Protector", "High Sum Insured"]
    if multi_gen:
        priority += ["Family Floater", "Restoration Benefit"]

    profile["priority_features"] = list(dict.fromkeys(priority))
    return profile



def match_policy_in_csv(company_name, plan_name, csv_content):
    """
    Robustly matches a policy in the CSV database.
    1. Filters by exact/fuzzy company name.
    2. Uses difflib to find best plan name match.
    """
    if not plan_name or not csv_content:
        return None

    best_match = None
    highest_ratio = 0.0
    
    # Normalize inputs safely
    norm_company = str(company_name).lower().strip() if company_name else ""
    norm_plan = str(plan_name).lower().strip() if plan_name else ""
    
    if not norm_plan:
        return None

    reader = csv.DictReader(io.StringIO(csv_content))
    
    for row in reader:
        # Check Company Match (handle "Co. Ltd" etc)
        csv_company = str(row.get("Insurance Company", "")).lower()
        if norm_company and csv_company:
            if norm_company not in csv_company and csv_company not in norm_company:
                 continue # Skip if company doesn't match at all
             
        # Check Plan Match
        csv_plan = str(row.get("Base Plan Name", "")).lower()
        ratio = difflib.SequenceMatcher(None, norm_plan, csv_plan).ratio()
        
        # Boost ratio if exact substring match
        if csv_plan and norm_plan in csv_plan:
            ratio += 0.1
            
        if ratio > highest_ratio:
            highest_ratio = ratio
            best_match = row

    # Threshold for acceptance
    if highest_ratio > 0.5 and best_match: # generous threshold due to variations
        matched_name = best_match.get('Base Plan Name', 'Unknown Plan')
        print(f"DEBUG: Found CSV Match! Input: '{plan_name}' -> Matched: '{matched_name}' (Score: {highest_ratio:.2f})")
        return best_match
    
    return None

def parse_date(date_str):
    for fmt in ("%d/%m/%Y", "%d-%m-%Y", "%Y-%m-%d", "%d-%b-%Y", "%d %b %Y"):
        try:
            return datetime.strptime(date_str.strip(), fmt)
        except ValueError:
            continue
    return None

async def generate_content_with_fallback(client, contents, model_list=None, use_schema=False, **kwargs):
    if model_list is None:
        model_list = MODEL_CANDIDATES
    last_exception = None
    for model in model_list:
        try:
            print(f"Attempting model: {model}")

            config_params = {"response_mime_type": "application/json"}
            
            # Merge kwargs into config_params (e.g. temperature, response_schema)
            if kwargs:
                config_params.update(kwargs) # This allows passing temperature=0.0

            if not use_schema and "response_schema" in config_params:
                config_params.pop("response_schema")

            # If tools are provided, we cannot enforce JSON mime_type easily on all models
            # But the user wants JSON. 
            if "tools" in config_params:
                 # If tools are used, mime_type must be removed for some models or handled differently
                 # ideally we keep tools in config and remove mime_type if it conflicts
                 config_params.pop("response_mime_type", None)

            response = await run_in_threadpool(
                client.models.generate_content,
                model=model,
                contents=contents,
                config=types.GenerateContentConfig(**config_params)
            )
            print(f"Success with model: {model}", flush=True)
            return response
        except Exception as e:
            print(f"Model {model} failed: {e}", flush=True)
            last_exception = e
            continue
    print("All models failed.")
    raise last_exception or Exception("All models failed")

def calculate_waiting_period_status(extracted_data, features_found):
    start_date_str = extracted_data.get("policy_details", {}).get("start_date", "")
    start_date = parse_date(start_date_str)
    if not start_date:
        return {}

    months_active = (datetime.now().year - start_date.year) * 12 + \
                    (datetime.now().month - start_date.month)

    def status(wait_months, served):
        if served >= wait_months:
            return "Cleared"
        remaining = wait_months - served
        y, m = divmod(remaining, 12)
        parts = []
        if y: parts.append(f"{y} year" + ("s" if y > 1 else ""))
        if m: parts.append(f"{m} month" + ("s" if m > 1 else ""))
        return f"{' '.join(parts)} remaining"

    # 1. Initial waiting period (always 30 days)
    statuses = {
        "Initial Waiting Period": {
            "wait_months": 1,
            "served_months": months_active,
            "status": status(1, months_active),
            "affects": "All new illnesses in first 30 days"
        }
    }

    # 2. Specific illness waiting period
    specific_wait = 24
    val = str(features_found.get("Specific Illness Waiting Period", "")).lower()
    if "1 year" in val or "12 month" in val: specific_wait = 12
    elif "2 year" in val or "24 month" in val: specific_wait = 24
    statuses["Specific Illness Waiting Period"] = {
        "wait_months": specific_wait,
        "served_months": months_active,
        "status": status(specific_wait, months_active),
        "affects": "Cataract, Hernia, Joint Replacement, Knee Surgery, Kidney Stones"
    }

    # 3. PED waiting period
    ped_wait = 48
    val = str(features_found.get("Coverage of Pre-Existing Diseases", "")).lower()
    if "2 year" in val: ped_wait = 24
    elif "3 year" in val: ped_wait = 36
    elif "4 year" in val: ped_wait = 48
    elif "day 1" in val or "zero" in val: ped_wait = 0
    statuses["Pre-Existing Disease (PED)"] = {
        "wait_months": ped_wait,
        "served_months": months_active,
        "status": "Day 1 Cover" if ped_wait == 0 else status(ped_wait, months_active),
        "affects": "Diabetes, Hypertension, Heart Disease, Thyroid, Asthma, PCOD"
    }

    # 4. Maternity waiting period
    mat_wait = 36
    val = str(features_found.get("Maternity", "")).lower()
    if "9 month" in val: mat_wait = 9
    elif "1 year" in val: mat_wait = 12
    elif "2 year" in val: mat_wait = 24
    elif "3 year" in val: mat_wait = 36
    elif "4 year" in val: mat_wait = 48
    elif "not covered" in val or "not available" in val: mat_wait = -1
    statuses["Maternity Cover"] = {
        "wait_months": mat_wait,
        "served_months": months_active,
        "status": "Not Covered" if mat_wait == -1 else status(mat_wait, months_active),
        "affects": "Normal Delivery, C-Section, Newborn Expenses, Pre/Post Natal"
    }

    return statuses

# ---------------------------------------------------------------------------
# ASYNC JOB WRAPPERS — kick off heavy AI work in background, return job_id
# ---------------------------------------------------------------------------

async def _run_extract_job(job_id: str, content: bytes, content_type: str, orig_filename: str, user: dict):
    try:
        JOB_STORE[job_id]["phase"] = "Running AI analysis (Pass 1 & 2 in parallel)..."
        result = await _extract_policy_core(content, content_type, orig_filename, user)
        JOB_STORE[job_id].update({"status": "completed", "result": result, "phase": "Done"})
    except Exception as e:
        JOB_STORE[job_id].update({"status": "failed", "error": str(e), "phase": "Failed"})
    finally:
        _cleanup_old_jobs()

async def _run_compare_job(job_id: str, data: dict, user: dict):
    try:
        JOB_STORE[job_id]["phase"] = "Generating analysis report..."
        result = await _compare_policy_core(data, user)
        JOB_STORE[job_id].update({"status": "completed", "result": result, "phase": "Done"})
    except Exception as e:
        JOB_STORE[job_id].update({"status": "failed", "error": str(e), "phase": "Failed"})
    finally:
        _cleanup_old_jobs()

@app.post("/api/extract")
async def extract_policy(file: UploadFile = File(...), user: dict = Depends(get_current_user)):
    """Thin handler: validates file, fires background job, returns job_id immediately."""
    content = await file.read()
    orig_filename = file.filename or "policy.pdf"
    content_type = file.content_type or "application/pdf"

    # Quick validations (synchronous — done before returning job_id)
    if len(content) > MAX_UPLOAD_SIZE_BYTES:
        raise HTTPException(status_code=413, detail=f"File too large. Maximum size is {MAX_UPLOAD_SIZE_BYTES / (1024*1024):.1f}MB.")
    kind = filetype.guess(content)
    allowed_mimes = ["application/pdf", "image/jpeg", "image/png"]
    if kind is None or kind.mime not in allowed_mimes:
        raise HTTPException(status_code=415, detail="Invalid document format. Only PDF, JPG, and PNG files are accepted.")

    job_id = str(uuid.uuid4())
    JOB_STORE[job_id] = {"status": "processing", "phase": "Reading document...", "result": None, "error": None, "created_at": time.time()}
    asyncio.create_task(_run_extract_job(job_id, content, content_type, orig_filename, user))
    return {"job_id": job_id}

@app.get("/api/job/{job_id}")
async def get_job_status(job_id: str, user: dict = Depends(get_current_user)):
    """Poll this endpoint to get the status and result of a background job."""
    job = JOB_STORE.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found or expired. Please retry.")
    return {
        "status": job["status"],   # "processing" | "completed" | "failed"
        "phase":  job["phase"],    # human-readable progress message
        "result": job.get("result"),
        "error":  job.get("error")
    }

# ---------------------------------------------------------------------------
# CORE LOGIC (extracted from route handlers — called by background jobs)
# ---------------------------------------------------------------------------

async def _extract_policy_core(content: bytes, content_type: str, orig_filename: str, user: dict):
    try:
        print(f"\n{'='*40}")
        print("🚀 [JOB] _extract_policy_core STARTED")
        print(f"📁 File: {orig_filename}")
        print(f"{'='*40}\n")

        
        print(f"📦 File Size: {len(content) / 1024:.1f} KB", flush=True)
        print("✅ Step 1/6: Security validation passed (already done in route handler).", flush=True)
        # ----------------------------

        # Read features CSV for context
        features_csv_content = FEATURES_CSV_CONTENT
        terminologies_csv_content = TERMINOLOGIES_CSV_CONTENT
        
        if not features_csv_content:
             features_csv_content = "Room Rent, NCB, Restoration, Waiting Periods, Co-pay"

        # --- NEW: Filter Features to only match Dataset Columns ---
        # User wants ONLY features present in the dataset to be displayed/extracted.
        try:
            if DATASET_COLUMNS:
                dataset_features = DATASET_COLUMNS

                # Parse features4.csv to filter lines
                filtered_lines = []
                # Keep header
                lines = features_csv_content.splitlines()
                if lines:
                    filtered_lines.append(lines[0]) 
                
                f_io = io.StringIO(features_csv_content)
                reader = csv.reader(f_io)
                next(reader)  # skip header row
                
                for row in reader:
                    if len(row) < 3: continue
                    category = row[0].strip()
                    feat_name = row[1].strip()
                    feat_name_lower = feat_name.lower()
                    description = row[2].strip()
                    
                    # Strict/Fuzzy Match check
                    matched = False
                    
                    if category in ["Non-Negotiable Benefits", "Must Have"]:
                        matched = True
                    
                    elif feat_name_lower in dataset_features:
                        matched = True
                    else:
                        matches = difflib.get_close_matches(feat_name_lower, dataset_features, n=1, cutoff=0.7)
                        if matches:
                            matched = True
                        else:
                            for df in dataset_features:
                                if feat_name_lower in df or df in feat_name_lower:
                                    matched = True
                                    break
                    
                    if matched:
                        # Construct a standardized string: "Term: Description (Category: CategoryName)"
                        # Using a format that's very natural for LLMs to parse contextually
                        filtered_lines.append(f"- {feat_name}: {description} (Category: {category})")
                
                # Update features_csv to only contain filtered list
                features_csv = "\n".join(filtered_lines)
                print(f"✅ Step 2/6: Feature list filtered to {len(filtered_lines)} items from dataset.", flush=True)
            else:
                features_csv = features_csv_content
        except Exception as e:
            print(f"WARNING: Feature Filtering Failed: {e}")
            features_csv = features_csv_content

        # --- PROMPT 1: DEMOGRAPHICS & FINANCIALS ---
        prompt_1 = f"""Analyze this health insurance document carefully. 

        INSTRUCTIONS (PASS 1: DEMOGRAPHICS AND FINANCIALS):
        1. Extract basic info:
           - **company**: EXTRACT THE FULL LEGAL NAME (e.g., "Go Digit General Insurance Ltd.", "HDFC ERGO General Insurance Company Ltd."). Do NOT use abbreviations like "Digit" or "HDFC".
           - **plan**: Extract the Base Plan Name.
           - **add_ons**: EXPLICITLY LOOK FOR "Add-on Policy", "Optional Covers", or "Riders" (e.g., 'Care Shield', 'Safeguard', 'No Claim Bonus Super'). Return them as a comma-separated string. THIS IS CRITICAL.
           - **premium**: Extract the total premium paid including taxes.
           - **coverage**: Extract the Policy Type (e.g., "Individual", "Family Floater").
        2. EXTRACT POLICY DATES:
           - Look for "Policy Start Date", "Inception Date", "Risk Start Date", or "Date of First Inception".
           - **CRITICAL**: Return the exact date string found (e.g., "12/05/2020") in the JSON under policy_details -> start_date.
           - **vintage**: Calculate Policy Vintage (e.g. "3 Years") if "Date of First Inception" is provided compared to the current date.
        3. EXTRACT POLICY HOLDERS: Look for names, dates of birth (DOB), and age. Return DOB in JSON.
        4. EXTRACT ADDRESS/LOCATION:
           - Look for the Proposer's address. Extract the **City** and **Pincode**.
        5. EXTRACT SUM INSURED BREAKDOWN:
             - **CRITICAL**: Identify "Base Sum Insured" (A). IF the document is a "Super Top Up" or "Top Up" policy, you MUST find the main "Sum Insured" coverage amount as a separate component distinct from the Deductible.
             - Identify "No Claim Bonus" / "Cumulative Bonus" (B).
             - **CRITICAL**: Look for "Cumulative Bonus Super" / "No Claim Bonus Super".
             - Identify "Additional Bonus" / "Recharge" (C).
             - **CRITICAL**: Identify "Deductible" or "Aggregate Deductible".
             - "components": Create a list of ALL distinct positive values found.
             - Labels: "Base Sum Insured", "Cumulative Bonus", "Super No Claim Bonus", "Recharge Benefit", "Deductible".
             - Example: [{{"label": "Base Sum Insured", "value": "10,00,000"}}, {{"label": "Deductible", "value": "50,000"}}]
             - **CRITICAL**: Do NOT include percentages. Output absolute currency AMOUNT. If a table gives both a percentage and an amount (e.g., "Super Credit Amount = 500000" vs "Super Credit % = 100"), you MUST extract the actual currency AMOUNT ("500000"), not the percentage!
             - **CALCULATE TOTAL**: The "total" field MUST be mathematically calculated as: (Base Sum Insured) + (Any Cumulative/Super Bonuses). Then, if a Deductible is present, you MUST SUBTRACT the Deductible from that sum. (e.g., 10L Base - 2L Deductible = 8,00,000 total).

        Return JSON format exactly like this:
        {{ 
          "company": "", 
          "plan": "", 
          "add_ons": "",
          "premium": "", 
          "coverage": "", 
          "city": "",
          "pincode": "",
          "policy_details": {{ "start_date": "", "vintage": "" }},
          "sum_insured": {{ 
             "total": "", 
             "components": [ {{ "label": "", "value": "" }} ]
          }},
          "policy_holders": [
            {{ "name": "", "dob": "", "age": "" }}
          ]
        }}
        """

        # --- PROMPT 2: MEDICAL FEATURES & STRICT GROUNDING ---
        prompt_2 = f"""You are a strict insurance auditor. You are analyzing a health insurance policy schedule.

        REFERENCE FEATURES LIST:
        {features_csv}

        SIMILAR TERMINOLOGIES MAPPING:
        {terminologies_csv_content}

        INSTRUCTIONS (PASS 2: MEDICAL FEATURES AND STRICT GROUNDING):
        You are a senior insurance auditor. Before filling the JSON, think step by step.

        <thinking_instructions>
        For EACH feature in the REFERENCE FEATURES LIST:
        1. Search the ENTIRE document (base policy + all add-ons + schedule page + fine print)
        2. Check synonyms from the SIMILAR TERMINOLOGIES MAPPING
        3. Note every section where this feature or its synonyms appear
        4. Note any caps, sub-limits, conditions, or exclusions
        5. Decide: Positive (clear coverage), Negative (absent/excluded), Partial (capped/limited)
        6. Extract the exact verbatim quote that proves your finding
        ONLY THEN output the JSON.
        </thinking_instructions>

        1. Scan the document for EVERY feature listed in the "REFERENCE FEATURES LIST" above.
        2. **EXACT KEY MAPPING**: Use the EXACT standardized "Term" (the text before the colon) from the list above as the key in your JSON output.
        3. **MEANING-BASED MAPPING & SYNONYMS**: Companies use hundreds of different names. Read the "Description" to understand what to look for. 
           - **IMPORTANT**: If the exact term isn't there, LOOK FOR SYNONYMS. 
           - Example: If the term is "Pre & Post Hospitalization", look for "Pre-hospitalization" and "Post-hospitalization" separately or "Pre/Post Hospitalization". If you find either or both, map it to the standardized term.
        4. **TERMINOLOGY MAPPING RULE**: Refer to the "SIMILAR TERMINOLOGIES MAPPING" for explicit examples, but DO NOT limit yourself to it. Use your intelligence to map any similar language to our standardized terms.
        5. CRITICAL ANCHORING RULE: Carefully examine the entire policy for Add-ons/Optional Covers (like "Care Shield", "Safe Guard", "Protect", etc.). You MUST associate features like "Consumables & Non-Payable Cover", "Claim Protector", and "Inflation Protector" with these Add-ons if they are present.
        6. **STRICT NEGATIVE SPACE RULE**: Only output "Not Explicitly Mentioned" if you have searched the entire document (including Add-ons and Fine Print) and found NO mention of the feature or its components.
        7. **VERBATIM QUOTES REQUIRED**: You must extract the exact verbatim sentence from the PDF that proves your finding. If a feature is split (like Pre/Post), combine the quotes.
        8. Capture specific limits (e.g., "30/60 Days", "Up to SI", "1% of SI").

        Return your analysis exactly conforming to the provided strict structured JSON format.
        You MUST provide an array of objects.
        Each object must include 'feature_name', 'verbatim_quote', and 'value' fields.
        """

        try:
            # Using Gemini's native PDF bytes handler for much faster processing
            # Bypassing slow Docling local conversion
            print("\n⚙️  Step 3/6: Sending PDF to Gemini AI (Pass 1 + Pass 2 in parallel)...", flush=True)
            print("   ├─ Pass 1: Extracting demographics, policy details, sum insured...", flush=True)
            print("   └─ Pass 2: Scanning for medical features & coverage details...", flush=True)
            part_content = types.Part.from_bytes(data=content, mime_type=content_type)

            # Parallel Execution of both prompts
            task1 = generate_content_with_fallback(
                client, [prompt_1, part_content], 
                model_list=PASS1_MODELS, 
                use_schema=True, 
                response_schema=Pass1Schema, 
                temperature=0.0
            )
            task2 = generate_content_with_fallback(
                client, [prompt_2, part_content], 
                model_list=PASS2_MODELS, 
                use_schema=True, 
                response_schema=Pass2Schema, 
                temperature=0.0,
                thinking_config=types.ThinkingConfig(thinking_budget=1024)
            )
            
            res1, res2 = await asyncio.gather(task1, task2)
            print("✅ Step 3/6: AI Pass 1 & 2 completed.", flush=True)
            
            # --- Parsing Pass 1 (Demographics) ---
            print("\n🔍 Step 4/6: Parsing AI responses...", flush=True)
            text1 = res1.text.strip()
            if "```json" in text1: text1 = text1.split("```json")[1].split("```")[0].strip()
            elif "```" in text1: text1 = text1.split("```")[1].split("```")[0].strip()
            data_p1 = json.loads(text1, strict=False)
            if isinstance(data_p1, list):
                data_p1 = data_p1[0] if len(data_p1) > 0 else {}
            print(f"   ├─ Pass 1 parsed: Company='{data_p1.get('company', '?')}', Plan='{data_p1.get('plan', '?')}'", flush=True)

            # --- Parsing Pass 2 (Features) ---
            text2 = res2.text.strip()
            if "```json" in text2: text2 = text2.split("```json")[1].split("```")[0].strip()
            elif "```" in text2: text2 = text2.split("```")[1].split("```")[0].strip()
            
            raw_p2 = json.loads(text2, strict=False)
            if isinstance(raw_p2, list):
                raw_p2 = raw_p2[0] if len(raw_p2) > 0 else {}
                
            # Remap Gemini's list of objects back to dict mapping expected by the rest of the application
            data_p2 = {
                "features_found": {}, 
                "verbatim_quotes": {}, 
                "comprehensive_findings": raw_p2.get("comprehensive_findings", "")
            }
            features_list = raw_p2.get("features", [])
            for feat in features_list:
                fname = feat.get("feature_name")
                if fname:
                    data_p2["features_found"][fname] = feat.get("value", "")
                    data_p2["verbatim_quotes"][fname] = feat.get("verbatim_quote", "")
                    
            feat_count = len(data_p2.get('features_found', {}))
            print(f"   └─ Pass 2 parsed: {feat_count} features extracted from document.", flush=True)
            print("✅ Step 4/6: All responses parsed successfully. (Pass 3 removed for speed optimization)", flush=True)
            
            # Merge JSON objects
            data = {**data_p1, **data_p2}

            # --- NEW: DATASET FALLBACK LOGIC ---
            # If features are "Not Explicitly Mentioned" in PDF, check the plan database
            try:
                company_name = data.get("company", "")
                plan_name = data.get("plan", "")
                print(f"\n🗄️  Step 6/6: Running fallback — checking database for: '{company_name}' / '{plan_name}'...", flush=True)
                if company_name and plan_name and PLANS_DATABASE_CSV_CONTENT:
                    matched_row = match_policy_in_csv(company_name, plan_name, PLANS_DATABASE_CSV_CONTENT)
                    if matched_row:
                        print(f"   ✅ Database match found: '{matched_row.get('Base Plan Name')}' — filling gaps...", flush=True)
                        features_found = data.get("features_found", {})
                        verbatim_quotes = data.get("verbatim_quotes", {})
                        
                        # Iterate through dataset columns to see if we can fill gaps
                        for feat_name, feat_val in matched_row.items():
                            if not feat_name or not feat_val: continue
                            
                            # Standardize key (Dataset headers are usually Title Case or snake_case)
                            # AI is instructed to use exact terms from features4.csv
                            key_norm = feat_name.strip()
                            
                            current_val = features_found.get(key_norm)
                            # If AI couldn't find it in PDF, use the database value
                            if not current_val or current_val == "Not Explicitly Mentioned":
                                str_val = str(feat_val).strip()
                                if str_val and str_val.lower() not in ["nan", "not applicable", "not available", "none"]:
                                    features_found[key_norm] = f"[From Database] {str_val}"
                                    verbatim_quotes[key_norm] = f"[From Database] Value retrieved from official {matched_row.get('Insurance Company')} specifications for '{matched_row.get('Base Plan Name')}'."
                        
                        data["features_found"] = features_found
                        data["verbatim_quotes"] = verbatim_quotes
            except Exception as e:
                print(f"WARNING: Dataset Fallback failed in extract_policy: {e}")

            # --- NEW: COMPULSORY FEATURES FALLBACK ---
            # Third layer: If strictly mandatory features are still missing, mark as "Standard Cover"
            try:
                features_found = data.get("features_found", {})
                verbatim_quotes = data.get("verbatim_quotes", {})
                
                # Create a map for robust case/plural variation matching
                ff_lower_map = {k.strip().lower(): k for k in features_found.keys()}

                for feat in COMPULSORY_FEATURES:
                    feat_lower = feat.strip().lower()
                    
                    # 1. Try exact lower match
                    actual_key = ff_lower_map.get(feat_lower)
                    
                    # 2. Try common variations
                    if not actual_key:
                        variations = [
                            feat_lower.rstrip('s'),
                            feat_lower + 's',
                            feat_lower.replace('hospitalisation', 'hospitalization'),
                            feat_lower.replace('hospitalization', 'hospitalisation')
                        ]
                        for v in variations:
                            if v in ff_lower_map:
                                actual_key = ff_lower_map[v]
                                break
                                
                    if not actual_key:
                        actual_key = feat
                        
                    current_val = features_found.get(actual_key)
                    
                    if not current_val or str(current_val).strip() == "Not Explicitly Mentioned" or str(current_val).strip() == "N/A":
                        features_found[actual_key] = "Standard Cover"
                        verbatim_quotes[actual_key] = "This is a standard feature/regulatory right provided by default in all IRDAI-approved health insurance policies."
                
                data["features_found"] = features_found
                data["verbatim_quotes"] = verbatim_quotes
            except Exception as e:
                print(f"WARNING: Compulsory Features Fallback failed: {e}")
            
            # --- NEW: WAITING PERIOD STATUS DASHBOARD ---
            try:
                data["waiting_period_status"] = calculate_waiting_period_status(
                    data, 
                    data.get("features_found", {})
                )
                print(f"DEBUG: Calculated Waiting Period Status for {len(data.get('waiting_period_status', {}))} categories.")
            except Exception as e:
                print(f"WARNING: Waiting Period Status calculation failed: {e}")

        except Exception as e:
            print(f"FAILED TO PARSE JSON in EXTRACT. Error: {e}")
            # Return safe default
            data = {
               "company": "Unknown", 
               "plan": "Unknown", 
               "premium": "0", 
               "coverage": "0", 
               "city": "Unknown",
               "pincode": "Unknown",
               "policy_details": { "start_date": "", "vintage": "Unknown" },
               "sum_insured": { "total": "0", "components": [] },
               "policy_holders": [],
               "features_found": {},
               "verbatim_quotes": {},
               "comprehensive_findings": "Could not extract data."
            }

        # --- PYTHON SIDE: RECALCULATE AGES PRECISELY ---
        # The LLM often hallucinates the current year or does bad math. 
        # We trust the DOB extraction more than the Age calculation.
        if "policy_holders" in data and isinstance(data["policy_holders"], list):
            today = datetime.now()
            for person in data["policy_holders"]:
                dob_str = person.get("dob", "")
                if dob_str:
                    # Try to parse DOB
                    dob_date = parse_date(dob_str)
                    
                    if dob_date:
                        # Calculate precise age
                        age = today.year - dob_date.year - ((today.month, today.day) < (dob_date.month, dob_date.day))
                        person["age"] = str(age) # Override LLM age

        # --- PYTHON SIDE: CALCULATE TOTAL SUM INSURED ---
        if "sum_insured" in data and "components" in data["sum_insured"]:
            components = data["sum_insured"]["components"]
            total_val = 0
            
            def extract_number(val_str):
                if not val_str: return 0
                s = str(val_str).strip().replace(',', '')
                # Handle decimals: If there's a dot, take only the integer part
                if '.' in s:
                    s = s.split('.')[0]
                # Remove non-digits
                clean = ''.join(c for c in s if c.isdigit())
                return int(clean) if clean else 0

            def format_indian_currency(n):
                s = str(n)
                if len(s) <= 3:
                    return s
                dic = s[:-3]
                last_3 = s[-3:]
                groups = []
                while len(dic) > 2:
                    groups.insert(0, dic[-2:])
                    dic = dic[:-2]
                groups.insert(0, dic)
                return ",".join(groups) + "," + last_3

            valid_components = []
            
            add_ons_str = str(data.get("add_ons", "")).lower()
            has_inflation_shield_feature = "inflation" in add_ons_str or "shield" in add_ons_str or "protector" in add_ons_str
            
            for comp in components:
                val = extract_number(comp.get("value", "0"))
                label = comp.get("label", "").lower()
                
                if val > 0:
                    # Skip percentages from calculation
                    if "%" in label or "percent" in label:
                         continue
                    
                    # [NEW] Check for Inflation Shield / Care Shield / Protector
                    # User Rule: Ignore PDF value, calculate standardized 7% per year
                    # FIXED: Removed "bonus super" to ensure No Claim Bonus Super is NOT skipped.
                    if "inflation" in label or "shield" in label or "protector" in label:
                         print(f"DEBUG: Detected Inflation Shield Feature '{label}' - Ignoring PDF Value {val}, will recalculate.")
                         has_inflation_shield_feature = True
                         continue # Skip adding the PDF value

                    if "deductible" in label:
                        # Deductibles are thresholds, they do not reduce or increase the Sum Insured total.
                        pass
                    else:
                        total_val += val

                    comp["value"] = format_indian_currency(val) # Apply Indian Format directly
                    valid_components.append(comp) # Add only valid components

            # Update with filtered list
            data["sum_insured"]["components"] = valid_components
            
            # --- NEW: STANDARDIZED INFLATION SHIELD CALCULATION ---
            if has_inflation_shield_feature:
                 try:
                    # 1. Calculate Tenure
                    years_active = 1
                    pd = data.get("policy_details") or {}
                    start_date_str = pd.get("start_date", "")
                    if start_date_str:
                         s_date = parse_date(start_date_str)
                         if s_date:
                             years_active = datetime.now().year - s_date.year
                             if years_active < 1: years_active = 1
                    
                    # 2. Find Base SI
                    base_si = 0
                    for comp in valid_components:
                        lbl = comp.get("label", "").lower()
                        if "base" in lbl or "sum insured" in lbl:
                             val_str = comp.get("value", "0")
                             base_si = extract_number(val_str)
                             break
                    
                    if base_si > 0:
                        # 3. Calculate Shield: Base * 7% * Years
                        inflation_amt = int(base_si * (CURRENT_INFLATION_RATE / 100) * years_active)
                        
                        if inflation_amt > 0:
                            shield_component = {
                                "label": f"Inflation Shield ({CURRENT_INFLATION_RATE}% x {years_active} yrs)",
                                "value": format_indian_currency(inflation_amt)
                            }
                            data["sum_insured"]["components"].append(shield_component)
                            
                            # Add to total
                            total_val += inflation_amt
                            print(f"DEBUG: Calculated Standardized Inflation Shield: {inflation_amt}")
                 except Exception as e:
                     print(f"WARNING: Standardized Inflation Shield Calc Failed: {e}")

            # FORCE OVERWRITE: Use our calculated total from valid components
            # This fixes the issue where AI's total includes hidden/hallucinated values
            if total_val > 0:
                data["sum_insured"]["total"] = format_indian_currency(total_val)
            else:
                data["sum_insured"]["total"] = "See Components / Not Found"

        # --- SUPABASE FILE UPLOAD (Only if authenticated) ---
        pdf_url = None
        if user and supabase_client:
            try:
                print(f"☁️ Uploading {orig_filename} to Supabase Storage...")
                file_bytes = content

                # Generate unique filename
                storage_filename = f"{user.get('sub')}/{datetime.now().strftime('%Y%m%d%H%M%S')}_{orig_filename}"

                # Upload to Supabase Storage bucket 'policy_pdfs'
                await run_in_threadpool(
                    supabase_client.storage.from_("policy_pdfs").upload,
                    file=file_bytes,
                    path=storage_filename,
                    file_options={"content-type": content_type}
                )
                
                # Get public URL
                pdf_url = supabase_client.storage.from_("policy_pdfs").get_public_url(storage_filename)
                
                # Append to JSON output
                data["pdf_file_url"] = pdf_url
                print(f"✅ File uploaded successfully! URL: {pdf_url}")
            except Exception as e:
                print(f"❌ Supabase Storage Error: {e}")
                # Don't fail extraction if upload fails

        print(f"\n{'='*40}")
        print(f"✅ [API] /api/extract COMPLETED SUCCESSFULLY!")
        print(f"   Company : {data.get('company', 'N/A')}")
        print(f"   Plan    : {data.get('plan', 'N/A')}")
        print(f"   Holders : {len(data.get('policy_holders', []))} person(s)")
        print(f"   Features: {len(data.get('features_found', {}))} extracted")
        print(f"   SI Total: {data.get('sum_insured', {}).get('total', 'N/A')}")
        print(f"{'='*40}\n")
        return data

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

def generate_admin_summary(policy_data: dict, report_data: dict, user_profile: dict) -> dict:
    """Generates a pre-call brief for agents, highlighting flags and talking points."""
    flags = []
    
    company_name = policy_data.get("company", "").lower()
    if any(b in company_name for b in BLACKLISTED_COMPANIES):
        flags.append("🚨 USER IS WITH A BLACKLISTED COMPANY")
        
    family_flags = user_profile.get("family_flags", {})
    if family_flags.get("has_senior"):
        flags.append("⚠️ SENIOR CITIZEN IN FAMILY (Needs separate targeted plan)")
        
    cost_level = user_profile.get("healthcare_cost_level", "")
    if cost_level in ["High", "Very High"]:
        flags.append(f"💰 HIGH TIER CITY: Recommend High SI ({user_profile.get('recommended_si_range')})")
        
    current_si = policy_data.get("sum_insured", {}).get("total", "Unknown")
    premium = policy_data.get("premium", "Unknown")
    score = report_data.get("product_score", 0)
    
    return {
        "key_flags": flags,
        "talking_points": [
            f"Current Policy Score: {score}/10",
            f"Current SI: {current_si} | Premium: {premium}",
            f"Key Priorities: {', '.join(user_profile.get('priority_features', []))}"
        ]
    }

def get_relevant_plans_subset(plans_csv: str, user_profile: dict, current_plan: dict = None, max_plans: int = 15) -> str:
    """Filters the huge plans CSV to a smaller subset based on user profile to save LLM tokens."""
    if not plans_csv:
        return ""
        
    try:
        reader = csv.DictReader(io.StringIO(plans_csv))
        headers = reader.fieldnames
        if not headers: return plans_csv
        
        scored_rows = []
        is_senior = user_profile.get("family_flags", {}).get("has_senior", False)
        is_maternity = user_profile.get("family_flags", {}).get("needs_maternity", False)
        
        current_plan_name = current_plan.get("Base Plan Name", "").lower() if current_plan else ""
        current_company = current_plan.get("Insurance Company", "").lower() if current_plan else ""
        
        for row in reader:
            score = 0
            plan_name = row.get("Base Plan Name", "").lower()
            company = row.get("Insurance Company", "").lower()
            
            if plan_name == current_plan_name and company == current_company:
                scored_rows.append((100, row))
                continue
                
            if any(b in company for b in BLACKLISTED_COMPANIES):
                continue
                
            if is_senior and ("senior" in plan_name or "care" in plan_name or "silver" in plan_name or "red carpet" in plan_name):
                score += 3
            if is_maternity and ("women" in plan_name or "maternity" in plan_name or "joy" in plan_name):
                score += 3
                
            if any(top in plan_name for top in ["optima", "reassure", "active", "health pre", "care supreme", "elevate"]):
                score += 1
                
            scored_rows.append((score, row))
            
        scored_rows.sort(key=lambda x: x[0], reverse=True)
        top_rows = [r[1] for r in scored_rows[:max_plans]]
        
        output = io.StringIO()
        writer = csv.DictWriter(output, fieldnames=headers)
        writer.writeheader()
        writer.writerows(top_rows)
        return output.getvalue()
    except Exception as e:
        print(f"DEBUG: Failed to subset plans: {e}")
        return plans_csv


@app.post("/api/compare")
async def compare_policy(data: dict, user: dict = Depends(get_current_user)):
    """Thin handler: fires background compare job, returns job_id immediately."""
    job_id = str(uuid.uuid4())
    JOB_STORE[job_id] = {"status": "processing", "phase": "Starting analysis...", "result": None, "error": None, "created_at": time.time()}
    asyncio.create_task(_run_compare_job(job_id, data, user))
    return {"job_id": job_id}

async def _compare_policy_core(data: dict, user: dict):
    try:
        print(f"\n{'='*40}")
        print("🚀 [API] /api/compare STARTED")
        print(f"🔍 Analyzing: {data.get('company', 'Unknown')} - {data.get('plan', 'Unknown')}")
        print(f"{'='*40}\n")
        
        # Read features from CSV
        features_csv = FEATURES_CSV_CONTENT
        if not features_csv:
            print("WARNING: features3.csv content missing")

        # Read Company Tiers from CSV
        company_data_csv = COMPANY_RATIOS_CSV_CONTENT
        if not company_data_csv:
             print("WARNING: company_performance_ratios.csv content missing")

        # Read Insurance Plans Database
        plans_database_csv = PLANS_DATABASE_CSV_CONTENT
        if not plans_database_csv:
             print("WARNING: Insurance_plan_dataset.csv content missing")

        # Read USP CSV
        usp_csv = USP_CSV_CONTENT
        if not usp_csv:
             print("WARNING: USP.csv content missing")

        # Calculate Policy Tenure from Inception Date
        pd = data.get('policy_details') or {}
        inception_date_str = pd.get('start_date', '')
        calculated_tenure = "Unknown"
        
        if inception_date_str:
            inception_date = parse_date(inception_date_str)
            if inception_date:
                today = datetime.now()
                # Calculate difference in years and months
                years = today.year - inception_date.year
                months = today.month - inception_date.month
                if months < 0:
                    years -= 1
                    months += 12
                calculated_tenure = f"{years} Years {months} Months"

        # [MODIFIED] Check if company exists in CSV (Robust Fallback Logic)
        company_name = data.get("company", "").lower().strip()
        is_company_known = False
        
        if company_name and company_data_csv:
            # 1. Direct substring check (fast)
            if company_name in company_data_csv.lower():
                is_company_known = True
            else:
                # 2. Reverse substring check (e.g. "Bajaj Allianz" in "Bajaj Allianz General Insurance...")
                try:
                    # Parse the CSV options to get list of valid company names
                    # We use a quick csv reader on the string content
                    reader = csv.DictReader(io.StringIO(company_data_csv))
                    for row in reader:
                        known_name = row.get("Company Name", "").strip().lower()
                        if known_name and (known_name in company_name):
                            is_company_known = True
                            print(f"DEBUG: Matched input '{company_name}' with known company '{known_name}'")
                            break
                        
                        # 3. First Word Check (e.g. "Chola" in "Cholamandalam")
                        # Split both by space and check if first token matches
                        known_first = known_name.split(' ')[0] if known_name else ""
                        
                        if known_first and len(known_first) > 3 and known_first in company_name:
                             # Safe guard: Only if first word is significant (>3 chars)
                             is_company_known = True
                             print(f"DEBUG: Fuzzy Matched First Word '{known_first}' in input '{company_name}'")
                             break
                except Exception as e:
                    print(f"WARNING: Failed to parse company CSV for matching: {e}")

        CSV_FALLBACK_INSTRUCTION = ""
        if not is_company_known:
            print(f"Company '{company_name}' not found in CSV. Using 'Others' fallback.")
            CSV_FALLBACK_INSTRUCTION = """
            **IMPORTANT: The company name is not explicitly found in Reference Data 2.**
            You MUST use the **"Others"** row from "Ref 2 CSV DATA" for the Current Policy Stats.
            - CSR: Use the value from the "Others" row.
            - Complaints: Use the value from the "Others" row.
            - Solvency: Use the value from the "Others" row.
            - Tier: Use the value from the "Others" row.
            """

        # [NEW] Perform Strict Verification against Plan Database
        input_plan_name = data.get("plan", "") # Plan is explicitly at root of extraction JSON
        verified_row = match_policy_in_csv(data.get("company", ""), input_plan_name, plans_database_csv)
        
        VERIFIED_DATA_SECTION = ""
        if verified_row:
            # Format row as a clean string for the LLM
            row_str = " | ".join([f"{k}: {v}" for k, v in verified_row.items() if v and v != "Not Applicable"])
            VERIFIED_DATA_SECTION = f"""
            *** VERIFIED DATABASE MATCH FOR CURRENT POLICY ***
            We found an EXACT MATCH for this policy in our database:
            Match: "{verified_row.get('Base Plan Name')}" by "{verified_row.get('Insurance Company')}"
            
            OFFICIAL DATA SPECS:
            {row_str}
            
            CRITICAL INSTRUCTION: You MUST use the above 'OFFICIAL DATA SPECS' if data is missing from the PDF.
            """

        # --- STEP 2: ANALYZE PROFILE & GENERATE COMPARISON ---
        user_profile = analyze_user_profile(data)
        
        # --- PROMPT COMPRESSION: FILTER RELEVANT PLANS ---
        relevant_plans_subset_csv = get_relevant_plans_subset(plans_database_csv, user_profile, current_plan=verified_row)

        # --- PREPARE FEATURE LIST STRING FOR PROMPT ---
        # strictly list the columns we want analyzed
        feature_list_str = "\n        ".join([f"- {col}" for col in DATASET_COLUMNS]) if DATASET_COLUMNS else "- (All columns in Ref 3)"

        # --- NEW: PARSE FEATURES BY CATEGORY FOR COMPARISON ---
        # We need specific lists to force the AI to check ALL of them for the Comparison section
        # CRITICAL FIX: Only include features that are ALSO present as columns in our Dataset (DATASET_COLUMNS)
        nn_features_list = []
        mh_features_list = []
        gth_features_list = []
        sf_features_list = []
        
        # Create a lowercase set of dataset columns for fast O(1) matching
        dataset_cols_set = {col.lower().strip() for col in DATASET_COLUMNS}
        
        # Map spelling differences between features3.csv and the dataset columns
        synonyms = [
            "in patient hospitalization", # maps to in-patient hospitalization
            "pre & post hospitalization", # maps to pre/post
            "safe guard",                 # maps to surplus/secure
            "modern treatment",           # maps to modern treatments
            "restoration benefit"         # maps to automatic restoration
        ]
        dataset_cols_set.update(synonyms)
        
        try:
            if FEATURES_CSV_CONTENT:
                # Simple CSV parsing of the string
                f_io = io.StringIO(FEATURES_CSV_CONTENT)
                reader = csv.reader(f_io)
                next(reader)  # skip header row
                
                for row in reader:
                    if len(row) >= 3:
                        cat = row[0].strip().lower()
                        feat = row[1].strip()
                        feat_lower = feat.lower()
                        description = row[2].strip()
                        
                        # Only include this feature if it exists in the Insurance_plan_dataset columns
                        if not dataset_cols_set or feat_lower in dataset_cols_set:
                            # Format: "Term: Description" for the prompt
                            feature_with_desc = f"{feat}: {description}"
                            if "non-negotiable" in cat:
                                nn_features_list.append(feature_with_desc)
                            elif "must have" in cat:
                                mh_features_list.append(feature_with_desc)
                            elif "good to have" in cat:
                                gth_features_list.append(feature_with_desc)
                            elif "special" in cat:
                                sf_features_list.append(feature_with_desc)
                                
                print(f"DEBUG: Filtered Features List to {len(nn_features_list) + len(mh_features_list) + len(gth_features_list) + len(sf_features_list)} items based on Dataset.")
        except Exception as e:
            print(f"Error parsing features for lists: {e}")
            # Fallbacks if parsing fails
            nn_features_list = ["Infinite Care", "No Sub-limits", "Consumables Cover", "Inflation Protector", "No Claim Bonus", "Restoration Benefit"]
            mh_features_list = ["Room Rent", "ICU Charges", "Day Care Treatments", "Claim Protector", "Pre & Post Hospitalization"]
            gth_features_list = ["Air Ambulance", "OPD Cover", "Wellness Benefits"]
            sf_features_list = ["Maternity", "Robotic Surgery", "Global Cover"]

        nn_features_str = ", ".join(nn_features_list)
        mh_features_str = ", ".join(mh_features_list)
        gth_features_str = ", ".join(gth_features_list)
        sf_features_str = ", ".join(sf_features_list)

        # REQUIRED PROMPT: Must match Frontend 'recommendations' schema
        # REFACTORED PROMPT STRUCTURE
        prompt = f"""
        Act as an expert insurance advisor for "Share India". 
        {CSV_FALLBACK_INSTRUCTION}
        
        # 1. INPUT DATA (CONTEXT)
        ---------------------------------------------------
        **EXISTING POLICY (Source of Truth)**:
        - Basic Info: {json.dumps(data)}
        - Policy Vintage: {data.get('policy_details', {}).get('vintage', 'Unknown')}
        - **CALCULATED TENURE**: {calculated_tenure} (Use this for Waiting Period Analysis)
        - Detailed Findings: {data.get('comprehensive_findings', 'Not available')}
        - Company: "{data.get('company')}"
        {VERIFIED_DATA_SECTION}

        **USER PROFILE** (personalize EVERY recommendation to this):
        - Age Group: {user_profile.get('age_group', 'General')}
        - Location: {data.get('city', 'Unknown')} ({user_profile['city_tier']})
        - Healthcare Cost Level: {user_profile.get('healthcare_cost_level', 'Moderate')}
        - Recommended SI Range: {user_profile.get('recommended_si_range', 'Unknown')}
        - Family: {user_profile.get('family_type', 'Individual')} ({user_profile.get('life_stage', 'Individual')})
        - Family Flags: Senior={user_profile.get('family_flags', {}).get('has_senior')}, Child={user_profile.get('family_flags', {}).get('has_child')}, NeedsMaternity={user_profile.get('family_flags', {}).get('needs_maternity')}, MultiGen={user_profile.get('family_flags', {}).get('multi_generation')}
        - PRIORITY FEATURES FOR THIS USER: {', '.join(user_profile.get('priority_features', []))}
        - Current Premium: {data.get('premium', 'Unknown')}
        
        **REFERENCE DATA**:
        - **Ref 1 (Features)**: Classification (Must Have, Good to Have, etc.).
        Ref 1 CSV DATA:
        {features_csv}

        - **Ref 2 (Company Performance)**: Claims Ratio, CSR, Solvency, Complaints.
        Ref 2 CSV DATA:
        {company_data_csv}

        - **Ref 3 (Plan Database)**: VALID Plans, Coverages, Limits. DO NOT INVENT PLANS.
        Ref 3 CSV DATA:
        {relevant_plans_subset_csv}

        - **Ref 4 (USPs)**: Unique Selling Points for plans.
        Ref 4 CSV DATA:
        {usp_csv}

        # 2. ANALYSIS RULES & LOGIC
        ---------------------------------------------------
        **A. WAITING PERIOD ANALYSIS**:
        - Use **CALCULATED TENURE** as "Time Served".
        - Compare against Waiting Periods for PEDs/Specific Illnesses.
        - If Time Served > Wait Period -> MARK AS COVERED / WAIT OVER.
        - If Time Served < Wait Period -> Calculate remaining time.

        **B. FEATURE CHECKLIST (MANDATORY)**:
        - **Analyze the following specific features (Columns from Ref 3)**:
        {feature_list_str}

        - **CRITICAL INSTRUCTION**: You MUST return a finding for **EVERY SINGLE FEATURE** listed above.
        - Do NOT skip any feature. If information is missing, estimate it or mark "Not Available".
        
        - **CATEGORY MAPPING RULE (STRICT)**:
          - You MUST assign each feature to EXACTLY ONE of these 4 categories:
            1. **"Non-Negotiable Benefits"**
            2. **"Must Have"**
            3. **"Good to Have"**
            4. **"Special Features"**
          - **CRITICAL**: The properties "Maternity", "Value Added", "Waiting Periods", etc., from Ref 1 are NOT valid categories for output.
          - **MAPPING**:
            - Map "Waiting Periods" -> **"Must Have"**
            - Map "Maternity", "Treatments" -> **"Special Features"**
            - Map "Value Added" -> **"Good to Have"**
          - If you return a category not in the top 4 list, IT WILL NOT BE DISPLAYED.

        - Status: "Positive" (Present/Good) or "Negative" (Missing/Capped/Bad).
        - Value: Short finding (e.g. "Capped at 1%", "Available", "Not Covered").
        - **IMPORTANT**: 
          - If the feature is confirmed to be **ABSENT** or **EXCLUDED**, set Value to **"Not Covered"**.
          - Do NOT use single words like "No" or "None". Use "Not Covered".
          - **NO CONTRADICTIONS ALLOWED (CRITICAL)**: Your `status` and `value` MUST NOT contradict the `policy_text` (verbatim quote). 
            - If the `policy_text` explicitly mentions a capping, limit, or condition (e.g., "Up to Single Private Room", "Capped at 1%"), you CANNOT mark the `value` as "Covered (No Sub-limits)". You MUST accurately state the limit (e.g., "Capped at Single Private Room") and set `status` to "Negative".
            - You will fail the audit if you give a green "Positive" status to a feature that the quote proves is restricted.

        **C. PRODUCT SCORE**:
        - **Data Source**: Use ONLY the ~28 features in Ref 3 (Plan Database).
        - **Formula**: (Count of Positive "Must Have" & "Non-Negotiable" matched in Ref 3) / (Total matched in Ref 3) * 10.
        - **Constraint**: Use this EXACT formula for both Current Policy and Recommendations.

        **D. RECOMMENDATION LOGIC (MULTI-FACTOR)**:
        1. **Geographical**: 
           - **Tier 1 (Metro)**: Recommend High SI (25L-50L+). High medical costs.
           - **Tier 2/3**: Balance coverage/affordability.
        2. **Age/Family Strategy**:
           - **Young**: Prioritize Age Lock, Wellness, Low Premium.
           - **Senior**: Prioritize No Co-pay, Short Wait Periods.
           - **Family**: Prioritize Maternity, Newborn, Restoration.
        3. **USP**: Cite specific USPs from Ref 4.
        4. **Premium**: Estimate premiums based on Age/SI/Market rates (2025). NO "Check website".
        
        **E. FAMILY COMPOSITION LOGIC (CRITICAL)**:
        - **Context**: The user is: {user_profile['family_type']} ({user_profile['life_stage']}).
        - **Age Group Context**: {user_profile.get('age_group', 'General')}
        - **IF FAMILY CONTAINS A SENIOR WITH MEDICAL HISTORY**: 
          - If the family has a senior member with medical history (see Age Group Context):
            1. **SPLIT THE RECOMMENDATIONS**: You MUST suggest a separate, dedicated senior citizen plan (focusing on Day-1 PED cover or low wait times) for the senior member(s).
            2. Suggest a different standard Floater/Family plan for the rest of the younger family members.
            3. Clearly label this separation in your category output (e.g., "Targeted Senior Care (For Older Members)" vs "Comprehensive Family Floater (For Rest of Family)").
        - **IF STANDARD FAMILY / FLOATER**:
          - YOU MUST prioritize plans that offer:
            1. **Maternity Benefits** (Look for "Maternity", "Newborn" in USPs/Features).
            2. **Restoration / Recharge** (Crucial for multiple members).
            3. **Floater USPs** (e.g. "Single SI for all", "Family Floater").
        - **IF INDIVIDUAL**:
          - Focus on **Personal usage** (e.g. "No Room Rent Cap", "OPD", "Wellness").

        **F. SELECTION CONSTRAINTS (STRICT)**:
        - **Quantity**: EXACTLY 3 distinct plans from DIFFERENT companies.
        - **Blacklist**: DO NOT recommend **Niva Bupa, Care Health, Star Health** (User Blocked).
        - **Allowed**: HDFC Ergo, ManipalCigna, Aditya Birla, SBI General, Bajaj Allianz, ICICI Lombard, Tata AIG, Future Generali.
        - **CRITICAL RULE**: Do NOT recommend the EXACT SAME plan the user currently has! The goal is to recommend an UPGRADE or a BETTER ALTERNATIVE. Recommending their current plan '{data.get('plan', 'Unknown')}' by '{data.get('company', 'Unknown')}' is STRICTLY FORBIDDEN.
        **G. LOCATION ANALYSIS (CRITICAL)**:
        - For the `location_analysis` -> `major_illnesses` array, you MUST provide EXACTLY 6 illnesses: Cancer, Bypass, Kidney failure, Angioplasty, Liver transplant, and Stroke.
        - Estimate their treatment costs at PREMIUM hospitals in {data.get('city', 'Unknown')} based on current rates. Do NOT omit any of the 6 illnesses.

        **H. FEATURE CONSOLIDATION & WEIGHTED SCORING (CRITICAL)**:
        1. **Consolidation**: Different companies use different terms (e.g., "Claim Protector", "Safe Guard", "Safe Guard +"). You MUST consolidate these overlapping terms under the single standard `Feature` name found in "Ref 1 CSV DATA" (e.g., "Claim Protector" or "Safe Guard"). Do NOT output both if they mean the same thing. Show only 1 unified row for that benefit.
        2. **Weighted Scoring (0.0 to 1.0)**: You MUST assign a `score_weight` to EVERY feature evaluated.
            - `1.0`: Best possible option/highest limit (e.g., No Room Rent Capping, Pre & Post 60/180 days).
            - `0.5 - 0.9`: Moderate limits (e.g., Pre & Post 30/60 days, Single Private Room Limit, Mandatory Standard Cover).
            - `0.1 - 0.4`: Poor limits/heavy restrictions (e.g., 1% Room Rent Cap, 10% Co-pay).
            - `0.0`: Completely Not Covered.
            - **RULE**: If a feature is "Standard Cover" or "[From Database]", set its `status` to "**Positive**" and `score_weight` to at least `0.75`.

        # 3. OUTPUT SCHEMA (JSON ONLY)
        ---------------------------------------------------
        Return PURE JSON. No markdown formatting.
        {{
            "family_analysis": {{
                "status": "{user_profile.get('family_type', 'Individual')}",
                "insight": "Based on your policy covering [Insert Members], we prioritized...",
                "key_priorities": ["List 3 top features relevant to this family type"]
            }},
            "location_analysis": {{
                "city": "{data.get('city', 'Unknown')}",
                "tier": "{user_profile['city_tier']}",
                "insight": "Healthcare costs in {data.get('city', 'your city')} are [High/Moderate/Low]... (Mention specific costs)",
                "major_illnesses": [
                    {{ "illness": "Cancer", "estimated_cost": "₹[Local Rate]" }},
                    {{ "illness": "Bypass", "estimated_cost": "₹[Local Rate]" }},
                    {{ "illness": "Kidney failure", "estimated_cost": "₹[Local Rate]" }},
                    {{ "illness": "Angioplasty", "estimated_cost": "₹[Local Rate]" }},
                    {{ "illness": "Liver transplant", "estimated_cost": "₹[Local Rate]" }},
                    {{ "illness": "Stroke", "estimated_cost": "₹[Local Rate]" }}
                ],
                "verdict": "Your Sum Insured of {data.get('sum_insured', dict()).get('total', '...')} is [Adequate/Insufficient] because..."
            }},
            "feature_analysis_dict": {{
                "Infinite Care": {{
                    "policy_text": "[Extract the exact quote mapping to this feature from 'EXISTING POLICY'. If missing, output 'Not Explicitly Mentioned']",
                    "status": "Positive", 
                    "value": "Available",
                    "score_weight": 1.0
                }},
                "Room Rent": {{
                    "policy_text": "[Extract from 'verbatim_quotes' dict]",
                    "status": "Positive", 
                    "value": "Standard Cover",
                    "score_weight": 0.8
                }}
                // ... MUST INCLUDE ALL DISTINCT FEATURES PASSED IN THE LISTS ABOVE ...
            }},
            "additional_discovered_features": [
                {{
                    "name": "Robotic Surgery",
                    "category": "Intelligently Assign: Non-Negotiable Benefits, Must Have, Good to Have, or Special Features",
                    "explanation": "Provide a 1-liner explanation in the style of the dataset.",
                    "policy_text": "Extracted exact text",
                    "status": "Positive",
                    "value": "Covered up to SI",
                    "score_weight": 0.8
                }}
            ],
            "product_score": 7.5,
            "current_policy_stats": {{
                "company": "Company Name",
                "csr": "98.5%", "csr_rank": "5",
                "solvency": "1.8", "solvency_rank": "1",
                "complaints": "95%", "complaints_rank": "2"
            }},
            "recommendations": [
                {{
                    "category": "Upgrade: [Type] (Reason)",
                    "items": [
                        {{
                            "company": "Full Legal Name",
                            "name": "Plan Name", 
                            "type": "...", 
                            "positive_features_count": 65,
                            "premium": "₹20,000 - ₹25,000", 
                            "description": "USP: ...", 
                             "stats": {{ "csr": "98.5%", "solvency": "1.8", "complaints": "95%" }},
                            "benefits": ["Benefit 1", "Benefit 2", "Benefit 3"],
                            "non_negotiable": [
                                {{ "feature": "Infinite Care", "existing": "Not Covered", "proposed": "Yes", "status": "Upgrade" }}
                            ],
                            "must_have": [
                                {{ "feature": "Room Rent", "existing": "1% limit", "proposed": "No Limit", "status": "Upgrade" }}
                            ],
                            "good_to_have": [
                                {{ "feature": "Air Ambulance", "existing": "Not Covered", "proposed": "Covered up to 2.5L", "status": "Upgrade" }}
                            ],
                            "special_features": [
                                {{ "feature": "Robotic Surgery", "existing": "Not Covered", "proposed": "Covered", "status": "Upgrade" }}
                            ],
                            "red_flags": [
                                "Co-payment clause present in many competitor base plans (highlight if relevant)"
                            ]
                        }}
                    ]
                }}
            ]
        }}
        
        CRITICAL INSTRUCTION FOR 'recommendations':
        1. **Quantity**: EXACTLY 3 distinct plans.
        2. **Diversity**: DIFFERENT COMPANIES.
        3. **COMPARISON LOGIC (STRICT)**:
           - **Rule**: Compare 'Existing Policy' vs 'Recommended Plan'.
           - **VISIBILITY**: If 'Existing' == 'Proposed' -> HIDE (Do not include in list). 
           - **EXCEPTION**: If distinct and differentiable -> SHOW.

        4. **MAPPING & SYNONYM STRATEGY**: 
           - Do NOT just look for exact word matches. Use the provided descriptions (next to each term below) to understand the *meaning* of the standardized features.
           - Map varying company terms to the correct standardized terms (e.g., if you see "Pre-Hospitalization" and "Post-Hospitalization" separately, map them both to "Pre & Post Hospitalization").
            - Use your intelligence as an insurance expert to bridge terminology gaps.
           - **CRITICAL**: If a feature value is exactly "**Standard Cover**", you MUST preserve this status as "**Positive**". Do NOT downgrade it to "Negative" or append speculative terms like "(Likely Capped)" unless you find a specific, explicit room rent limit clause in the "EXISTING POLICY" text.

        5. **NON-NEGOTIABLE BENEFITS**:
           - **MANDATORY CHECK**: You MUST iterate through **EACH** of these features:
             [{nn_features_str}]
           - For **EVERY** feature in this list:
             - Use the EXACT standardized "Term" (the part before the colon) from the list above.
             - Compare Existing vs Proposed.
             - If they differ (even slightly, e.g. "Capped" vs "No Limit"), **YOU MUST INCLUDE IT**.
             - ONLY skip if they are absolutely identical (e.g. "Covered" vs "Covered").
        
        6. **MUST HAVE FEATURES**:
           - **MANDATORY CHECK**: You MUST iterate through **EACH** of these features:
             [{mh_features_str}]
           - Same rule: If they differ, **INCLUDE IT**. Do NOT filter out valid differences.

        7. **GOOD TO HAVE FEATURES**:
           - **MANDATORY CHECK**: You MUST iterate through **EACH** of these features:
             [{gth_features_str}]
           - Same rule: Compare Existing vs Proposed. If they differ significantly, **INCLUDE IT**. ONLY skip if they are absolutely identical or not relevant to either plan.
           
        8. **SPECIAL FEATURES**:
           - **MANDATORY CHECK**: You MUST iterate through **EACH** of these features:
             [{sf_features_str}]
           - Same rule: Compare Existing vs Proposed. If they differ, **INCLUDE IT**. ONLY skip if they are absolutely identical.

        CRITICAL INSTRUCTION FOR 'current_policy_stats':
        - Look up the **EXISTING POLICY'S COMPANY** in "Ref 2 CSV DATA".
        - **CSR (Claim Settlement Ratio)**: Extract the value from the **"Claims Paid Ratio"** column (Col 2) and its **Rank** (Col 3).
        - **Complaints**: Extract "Complaints Settlement Ratio" (Column 9) and its **Rank** (Column 10).
        - **Solvency**: Extract "Solvency Ratio" (March 2024 value) and its **Rank** (Column 16).
        - **Format**: 
          - Ratios: Percentage or Number (e.g. "98.5%", "1.85").
          - Ranks: **ONLY THE NUMBER** (e.g. "1", "5", "10"). Do NOT add "Top" or "Tier".

        CRITICAL INSTRUCTION FOR 'stats' FIELD (Recommendations):
        - Same logic as above. Extract Ratio and Rank.
        - JSON Structure for stats: {{ "csr": "98%", "csr_rank": "5", "solvency": "1.8", "solvency_rank": "1", "complaints": "99%", "complaints_rank": "2" }}
        - **csr**: Extract "Claims Paid Ratio" from "Ref 2 CSV DATA". Format as percentage (e.g. "98.2%").
        - **solvency**: Extract "Solvency Ratio" from "Ref 2 CSV DATA". Format as number (e.g. "1.9").
        - **complaints**: Extract "Complaints Settlement Ratio" from "Ref 2". Format as percentage (e.g. "98%").
        - If data is missing for a company, estimate based on tier.

        CRITICAL INSTRUCTION FOR 'benefits' FIELD:
        - You MUST list 3-4 KEY SELLING POINTS from "Reference Data 3" (Plan Database).
        - Focus on "No Room Rent Limit", "Unlimited Restoration", "Bonus", or "No Claim Bonus".
        - Short, punchy bullet points.

        3. **PREMIUM ESTIMATION (MANDATORY)**:
           - **CRITICAL RULE**: NEVER, under any circumstances, output "Please search" or "Check website". This is an automated report. YOU must provide the data.
           - **Method 1 (Search)**: Try to find the actual premium brochure via Google Search.
           - **Method 2 (Estimation - REQUIRED Fallback)**: If search fails, you **MUST ESTIMATE** the premium based on:
             - **Age**: {data.get('policy_holders', [{'age': 30}])[0].get('age', 30)} years
             - **Sum Insured**: {data.get('policy_details', {}).get('sum_insured', '5 Lakh')}
             - **Family Type**: {data.get('policy_type', 'Individual')}
             - **Market Knowledge**: Use your internal knowledge of 2025 Indian Health Insurance pricing.
           - **Output Format**: Always output a realistic range (e.g. "₹22,000 - ₹26,000").
           - **Constraint**: Premiums must vary by plan.

        **CRITICAL SELECTION LOGIC (DYNAMIC & PERSONALIZED)**:
        Do NOT just pick the top 3 companies by CSR. You MUST select plans that fit the **User Profile**:
        - **Profile**: {user_profile['age_group']}
        - **Location**: {user_profile['city_tier']}
        
        **Selection Strategy**:
        1. **Young Users (<35)**: Prioritize plans with "Age Lock", "Wellness Points", or "Low Premiums" (e.g. Niva Bupa ReAssure, Aditya Birla).
        2. **Seniors (>50, No Medical History)**: Prioritize "No Co-pay", "Reduced PED Waiting" (e.g. Care Senior, Star Health).
        3. **Seniors WITH Medical History**: YOU MUST suggest a SEPARATE targeted plan. Prioritize "Day 1 PED Cover" or Zero Waiting periods for pre-existing diseases. Mention this in the reason.
        4. **Tier 2/3 Cities**: Prioritize "Value for Money" & "Network Strength" (e.g. SBI, Bajaj).
        5. **Premium Seekers (Tier 1)**: Prioritize "High No Claim Bonus", "Global Cover", "Infinite Restoration" (e.g. HDFC Optima Secure, Manipal Cigna).
        
        **DIVERSITY RULE**: 
        - Choose 3 Distinct Companies.
        - **CSR Filter**: Ensure all selected companies have **CSR > 85%**.
        - **Sorting**: Among the suitable plans, rank them by how well they solve the user's specific needs, NOT just by CSR. Be smart. Not everyone needs the most expensive Platinum plan.

        **NEGATIVE CONSTRAINT (STRICT)**:
        - **DO NOT** recommend plans from the following companies: **Niva Bupa, Care Health, Star Health**.
        - The user has explicitly blocked them.
        - FAILURE to follow this will result in a penalty.
        - Recommended Alternatives: HDFC Ergo, ManipalCigna, Aditya Birla, SBI General, Bajaj Allianz, ICICI Lombard.
        - **CRITICAL**: ONLY select from these alternatives IF they have a plan explicitly listed in "Ref 3"!!

        3. **DISPLAY RULES (STRICT)**:
           - **Company Name**: Output ONLY the official company name (e.g., "HDFC Ergo"). **DO NOT** append "(Tier 1)" or any other stats to the name string. The user wants a clean display.
           - **Description Field (CRITICAL - USP)**:
             - You MUST find the **Unique Selling Point (USP)** of this specific plan from its brochure or your knowledge.
             - START the description with "USP: [The USP]".
             - Follow it with a brief 1-line overview of why this plan is superior.
             - Example: "USP: Industry's only unlimited restoration benefit for unrelated illnesses. This plan offers..."

        4. **DATA SOURCE RULES (STRICT)**:
           - **Current Policy Data ("Existing")**:
             - PRIMARY SOURCE: Use the 'DETAILED FOUND FEATURES' text block provided at the top.
             - **SECONDARY SOURCE (CRITICAL)**: If a feature is NOT found in the text, check **Reference Data 3 (Plan Database)**. If the *Current Policy Name* matches a plan in that CSV, USE THAT DATA to fill missing fields.
             - **TERTIARY SOURCE (WEB SEARCH)**: If the feature is NOT in the PDF or the CSV, you **MUST** use the Google Search tool to find the official brochure/policy wording for the specific '[Company Name] [Plan Name]'. Look specifically for the missing feature value.
             - **FINAL FALLBACK**: Only output "Not Available" if the feature is completely unknown after checking PDF, CSV, and the Web.
             - **CRITICAL**: Do NOT output "Unknown" or "Not Mentioned. If you don't see it in the text, ESTIMATE it based on standard market features for that plan.
             - **PED WAITING PERIOD LOGIC**:
               - Identify the "Pre-Existing Disease" or "PED" waiting period from the found features (usually 2, 3, or 4 years).
               - Compare it against the **Policy Vintage** ({data.get('policy_details', {}).get('vintage', 'Unknown')}).
               - If Vintage > Waiting Period, set the Existing Value to "**Passed**" or "**Waived**".
               - If Vintage < Waiting Period, set the Existing Value to "**X Years Remaining**" (calculate the difference).
           - **Recommended Policy Data ("Proposed")**: You MUST use "Reference Data 3 (Plan Database)" for ALL recommended plan details.
           - **Feature Categorization**: You MUST use "Reference Data 1" (features3.csv) to decide if a feature is "Non-Negotiable Benefits", "Must Have", "Good to Have", etc.
           - **Company Tier**: You MUST use "Reference Data 2" (Company Ratios) for Tier and reliability stats. 
           
        5. **DISPLAY RULES**:
           - **Extracted Company Name**: Output the full legal name (e.g. "The New India Assurance Co. Ltd."). 
           - **CRITICAL cleanup**: CUT OFF any text that appears **after** "Ltd." or "Co.". 
           - **REMOVE** any parenthetical text like "(Government of India Undertaking)" or "(A Joint Venture...)" if it appears after the main name.
           - Example: "The New India Assurance Co. Ltd. (Govt of India)" -> "The New India Assurance Co. Ltd."
           - **Row Visibility**: If a feature is "No" or "Unknown" for BOTH the "Existing" and "Proposed" policy, DO NOT include that row in the output JSON. We only want to see differences or relevant features.
           - **Company Tier**: You MUST use "Reference Data 2" (Company Ratios) for Tier and reliability stats.

        9. **RED FLAGS / THINGS TO AVOID**:
           - Check the "Red Flag" category in Reference Data 1 (e.g., Co-Payment, Room Rent Limits).
           - If the *Recommended Plan* has any of these, OR if the *Current Policy* has them and they are being eliminated, mention it.
           - Example logic: "The existing 20% Co-Payment is eliminated in this proposed plan." OR "Warning: This plan has a 10% Co-Payment."
           - Populate the "red_flags" JSON array with these warnings.
        10. **INTELLIGENT EXTRA FEATURE EXTRACTION**:
           - Read through the policy copy carefully.
           - If you find ANY interesting, critical, or unique features that are NOT covered by our {len(DATASET_COLUMNS)} standard dataset checklist, you MUST extract them!
           - Put them in the `additional_discovered_features` array.
           - For each extra feature:
             - Intelligently assign it a `category`: Choose from "Non-Negotiable Benefits", "Must Have", "Good to Have", or "Special Features".
             - Write a professional 1-liner `explanation` detailing what the feature means in simple terms (like the CSV examples).
             - Provide the `policy_text`, `status`, `value`, and `score_weight`.

        11. **PROS vs CONS (STRICT FEATURE MAPPING)**:
           - **Reference**: Use 'Reference Data 1' ({features_csv}) for the list of Must Have/Good to Have features AND their "One-liner Explanation".
           - **PROS Logic**: 
             - List features from 'Reference Data 1' that the **EXISTING POLICY HAS**.
             - Format: "Feature Name: [Details/Limit]. [One-liner Explanation]"
             - Example: "Room Rent: Covered up to 1% of SI. Covers hospital room charges up to eligible limits."
             - Do NOT use prefixes like "Must Have:" or "Good to Have:".
           - **CONS Logic**: 
             - List features from 'Reference Data 1' that the **EXISTING POLICY LACKS** (or has poor limits on).
             - Format: "Feature Name: Not Covered / limit is low. [One-liner Explanation]"
             - Example: "Robotic Surgery: Not Covered. Covers advanced medical treatments like robotic surgery."
             - Do NOT use prefixes like "Missing:", "Must Have:", or "Red Flag:". Just the statement.
             - Also check "Red Flags" present in the existing policy.
           - **Format**: Return simple string arrays.
        12. **LOCAL HEALTH INSIGHT (CRITICAL)**:
           - You MUST precisely provide cost estimates for the user's specific city: `{data.get('city', 'Unknown')}`.
           - Output EXACTLY these 6 illnesses: Cancer, Bypass, Kidney failure, Angioplasty, Liver transplant, Stroke. Do not include any others.
           - Use your internal knowledge to fetch realistic hospitalization costs for treating those specific 6 illnesses at **premium, top-tier private hospitals** in that exact city.
           - Precisely adjust the `estimated_cost` to reflect the local market rate for each of these 6 illnesses based on the city.
           - Ensure the estimated costs are realistic for {data.get('city', 'Unknown')}.
        """

        try:
            response = await generate_content_with_fallback(
                client,
                contents=prompt,
                temperature=0.0 # Deterministic output
            )

        except Exception as e:
             print(f"ALL MODELS FAILED: {e}")
             raise HTTPException(status_code=429, detail="All AI models are currently busy. Please try again later.")

        text = response.text
        if not text:
            raise ValueError("AI returned empty response")
        
        print(f"DEBUG: AI Raw Text (First 500 chars): {text[:500]}...")
        
        text = text.replace("```json", "").replace("```", "").strip()
        try:
             result = json.loads(text)
             # DEBUG: Dump the parsed result
             with open("debug_result.json", "w") as f:
                 json.dump(result, f, indent=2)

             # --- DETERMINISTIC FEATURE MAPPING ---
             # We take the raw dict from AI and stitch it back to the EXACT static categories and explanations from the CSV
             if "feature_analysis_dict" in result:
                 feature_dict_raw = result["feature_analysis_dict"]
                 # Normalize AI keys to lowercase
                 dict_keys_lower = {k.lower().strip(): v for k, v in feature_dict_raw.items()}
                 
                 feature_analysis_array = []
                 if FEATURES_CSV_CONTENT:
                     # Parse CSV line by line to keep exact global order and spelling
                     reader = csv.reader(io.StringIO(FEATURES_CSV_CONTENT))
                     for row in reader:
                         # Ensure we only process rows with enough columns
                         if len(row) >= 3 and row[0].strip().lower() != "category": 
                             cat = row[0].strip()
                             feat = row[1].strip()
                             exp = row[2].strip()
                             
                             feat_lower = feat.lower()
                             
                             item = None
                             if feat_lower in dict_keys_lower:
                                 item = dict_keys_lower[feat_lower]
                             else:
                                 # Fuzzy match fallback
                                 matches = difflib.get_close_matches(feat_lower, dict_keys_lower.keys(), n=1, cutoff=0.8)
                                 if matches:
                                     item = dict_keys_lower[matches[0]]
                             
                             # If AI evaluated it, append to final array
                             if item:
                                 # Safely parse score_weight to float
                                 score_val = item.get("score_weight", 0.0)
                                 try:
                                     score_val = float(score_val)
                                 except (ValueError, TypeError):
                                     score_val = 0.0
                                     
                                 feature_analysis_array.append({
                                     "category": cat,
                                     "feature": feat,
                                     "explanation": exp,
                                     "policy_text": item.get("policy_text", "Not Explicitly Mentioned"),
                                     "status": item.get("status", "Negative"),
                                     "value": str(item.get("value", "Not Covered")),
                                     "score_weight": score_val
                                 })
                 
                 # Safely parse and append any dynamically discovered extra features
                 if "additional_discovered_features" in result and isinstance(result["additional_discovered_features"], list):
                     for extra_item in result["additional_discovered_features"]:
                         # Check if all required keys exist to prevent frontend crash
                         if "name" in extra_item:
                             
                             score_val = extra_item.get("score_weight", 0.0)
                             try:
                                 score_val = float(score_val)
                             except (ValueError, TypeError):
                                 score_val = 0.0
                                 
                             feature_analysis_array.append({
                                 "category": extra_item.get("category", "Special Features"),
                                 "feature": extra_item["name"],
                                 "explanation": extra_item.get("explanation", "Extracted intelligently by AI."),
                                 "policy_text": extra_item.get("policy_text", "Not Explicitly Mentioned"),
                                 "status": extra_item.get("status", "Positive"),
                                 "value": str(extra_item.get("value", "Not Covered")),
                                 "score_weight": score_val
                             })
                 
                 # Assign the perfectly structured array back to the expected key
                 result["feature_analysis"] = feature_analysis_array
                 print(f"DEBUG: Stitched Feature Analysis Count: {len(result['feature_analysis'])}")
                 
             if "feature_analysis" in result:
                 # --- DETERMINISTIC SCORE CALCULATION (WEIGHTED) ---
                 # Calculate score using the fractional `score_weight` (0.0 to 1.0) provided by LLM
                 try:
                     features = result.get('feature_analysis', [])
                     total_evaluated = len(features)
                     
                     if total_evaluated > 0:
                         total_weight = 0.0
                         for item in features:
                             # Default to 0 if missing or invalid
                             try:
                                 weight = float(item.get("score_weight", 0.0))
                                 # Cap weight between 0.0 and 1.0 just to be safe
                                 weight = max(0.0, min(1.0, weight)) 
                             except (ValueError, TypeError):
                                 weight = 0.0
                                 
                             total_weight += weight
                             
                         # Calculate Score: (Sum of Weights / Total Evaluated Features) * 10
                         calc_score = (total_weight / total_evaluated) * 10
                         
                         # Hard Cap at 10 to prevent bug where score > 10
                         calc_score = min(10.0, calc_score)
                         
                         result['product_score'] = round(calc_score, 2)
                         print(f"DEBUG: Calc Weighted Score: {result['product_score']} (Total Weight: {total_weight}/{total_evaluated})")
                     else:
                         result['product_score'] = 0.0
                         
                 except Exception as e:
                     print(f"DEBUG: Score Calculation Failed: {e}")
                     if 'product_score' not in result:
                         result['product_score'] = 0.0

             if "recommendations" in result:
                 # Standardize Structure: Frontend expects [{ category:..., items: [...] }]
                 recs = result['recommendations']
                 
                 # Case 1: AI returned a flat list of plans directly
                 if isinstance(recs, list) and len(recs) > 0 and "items" not in recs[0]:
                     print("DEBUG: Detected Flat List of Recommendations. Wrapping in Category.")
                     result['recommendations'] = [{
                         "category": "Recommended Upgrades",
                         "items": recs
                     }]
                 
                 # Inspect the standardized structure
                 final_recs = result['recommendations']
                 
                 # --- NEW STRICT LIMIT: EXACTLY 3 RECOMMENDATIONS ---
                 trimmed_recs = []
                 plans_kept = 0
                 
                 for cat in final_recs:
                     items = cat.get('items', [])
                     kept_items = []
                     for plan in items:
                         if plans_kept >= 3:
                             break
                             
                         c_name = plan.get('company', 'Unknown').lower().strip()
                         # --- BLACKLIST FILTER ---
                         if any(blocked in c_name for blocked in BLACKLISTED_COMPANIES):
                             print(f"DEBUG: Skipped Blacklisted Company: {c_name}")
                             continue
                             
                         kept_items.append(plan)
                         plans_kept += 1
                         
                     if kept_items:
                         cat['items'] = kept_items
                         trimmed_recs.append(cat)
                         
                     if plans_kept >= 3:
                         break
                         
                 result['recommendations'] = trimmed_recs
                 final_recs = trimmed_recs
                 
                 print(f"DEBUG: Recommendation Categories (Trimmed): {len(final_recs)}")
                 
                 total_plans = 0
                 for cat in final_recs:
                     items = cat.get('items', [])
                     total_plans += len(items)
                     for idx, plan in enumerate(items):
                         c_name = plan.get('company', 'Unknown').lower().strip()
                         p_name = plan.get('name', 'Unknown').lower().strip()
                         
                         # --- OVERRIDE WITH PRE-CALCULATED SCORES & USP ---
                         if PLAN_SCORES_DATA:
                             # 1. subset scores by company to handle same-name plans (e.g. Premier Plan)
                             # Clean both names extensively for intersect mapping
                             c_norm = c_name.lower().replace("company", "").replace("co.", "").replace("ltd.", "").replace("ltd", "").replace("general insurance", "").replace("health insurance", "").replace("insurance", "").strip()
                             candidate_scores = {} 
                             
                             for k, v in PLAN_SCORES_DATA.items():
                                 if "|" in k:
                                     k_p, k_c = k.split("|") # Format: plan|company
                                     # Clean target key similarly
                                     k_c_norm = k_c.lower().replace("general insurance", "").replace("health insurance", "").replace("insurance", "").strip()
                                     
                                     # Company Match: Fuzzy containment
                                     if k_c_norm in c_norm or c_norm in k_c_norm:
                                         candidate_scores[k_p] = v, k # Store value and full key
                             
                             # 2. Match Plan Name within candidates
                             matched_data = None
                             matched_p_name = None
                             
                             if p_name in candidate_scores:
                                 matched_data, _ = candidate_scores[p_name]
                                 matched_p_name = p_name
                             else:
                                 # Fuzzy match plan name
                                 match = difflib.get_close_matches(p_name, candidate_scores.keys(), n=1, cutoff=0.6)
                                 if match:
                                     matched_data, _ = candidate_scores[match[0]]
                                     matched_p_name = match[0]
                                     print(f"DEBUG: Fuzzy matched '{p_name}' to '{matched_p_name}' for company '{c_name}'")

                             if matched_data:
                                 plan['product_score'] = matched_data['score']
                                 plan['positive_features_count'] = matched_data['positives']
                                 plan['total_features_count'] = matched_data['total']
                                 
                                 # Update p_name for USP lookup
                                 # Need to reconstruct the composite key for USP lookup if USP data also uses composite keys?
                                 # Yes, PLAN_USP_DATA now uses composite keys too.
                                 
                                 # Let's try to find USP using the same composite key logic
                                 # We can't just set p_name = matched_p_name because USP lookup needs company too.
                                 
                                 # --- USP OVERRIDE ---
                                 # PLAN_USP_DATA keys are also "plan|company"
                                 # We can try to construct the key using the matched plan name and the matched company from score data?
                                 # Value in candidate_scores was (v, k). k is the full key "plan|company"
                                 
                                 _, full_key = candidate_scores[matched_p_name]
                                 
                                 if full_key in PLAN_USP_DATA:
                                     usp = PLAN_USP_DATA[full_key]
                                     if not usp.lower().startswith("usp"):
                                         plan['description'] = f"USP: {usp}"
                                     else:
                                         plan['description'] = usp
                                     print(f"DEBUG: Injected USP for {full_key}")


                         # (USP injection handled above in score block)

                         # Get values for display
                         feat_count = plan.get('positive_features_count', 0)
                         total_count = plan.get('total_features_count', 30) # Default to ~30 if not found
                         calc_score = plan.get('product_score', 0)
                             
                         print(f"DEBUG: Plan {idx+1} ({c_name}): Positive Features = {feat_count}/{total_count} --> Score = {calc_score}/10")

                 print(f"DEBUG: Total Recommended Plans Found: {total_plans}")

        except json.JSONDecodeError:
             # Fallback: Find the first { and last }
             try:
                 start = text.find("{")
                 end = text.rfind("}") + 1
                 if start != -1 and end != -1:
                     result = json.loads(text[start:end])
                 else:
                     raise ValueError("No JSON found in text")
             except Exception:
                 print(f"FAILED TO PARSE JSON. Raw text: {text}")
                 # Return a safe default object to prevent crash
                 result = {
                    "pros": ["Could not analyze policy details."],
                    "cons": ["AI response was not in expected format."],
                    "current_policy_stats": {
                        "company": data.get("company", "Unknown"),
                        "csr": "N/A", "csr_rank": "N/A",
                        "solvency": "N/A", "solvency_rank": "N/A",
                        "complaints": "N/A", "complaints_rank": "N/A"
                    },
                    "recommendations": []
                 }

        # Limit pros/cons to a clean display length (no artificial suppression)
        if "pros" in result and "cons" in result:
            result["pros"] = result["pros"][:7]
            result["cons"] = result["cons"][:7]

        # --- COVERAGE VERDICT: Suppress recommendations if plan is already good ---
        # Default threshold is 7.5, but relaxed to 7.0 when EFFECTIVE SI is "Optimal" (>= 50L)
        # because high SI alone is a strong signal of a well-funded plan.
        current_score = result.get("product_score", 0)

        # Compute EFFECTIVE SI (Base + Bonuses - Deductibles/Co-pay) from components
        # This mirrors the frontend's getEffectiveSITotal() logic exactly.
        try:
            si_components = data.get("sum_insured", {}).get("components", [])
            additive_total = 0
            subtractive_total = 0
            has_components = False

            for comp in si_components:
                label = str(comp.get("label", "")).lower()
                val_str = str(comp.get("value", "0")).replace(",", "")
                val = float(''.join(c for c in val_str if c.isdigit() or c == '.') or "0")
                if val > 0:
                    has_components = True
                    if "deductible" in label or "co-pay" in label or "copay" in label:
                        subtractive_total += val
                    else:
                        additive_total += val

            if has_components and (additive_total - subtractive_total) > 0:
                si_numeric = int(additive_total - subtractive_total)
            else:
                # Fallback: parse the raw total string
                si_raw = str(data.get("sum_insured", {}).get("total", "0")).replace(",", "").strip()
                si_numeric = int(''.join(c for c in si_raw if c.isdigit()) or "0")
        except Exception:
            si_numeric = 0

        print(f"DEBUG: Effective SI = {si_numeric} (₹{si_numeric/100000:.1f}L)")

        HIGH_SI_THRESHOLD = 5_000_000  # 50 Lakhs
        if si_numeric >= HIGH_SI_THRESHOLD:
            GOOD_COVERAGE_THRESHOLD = 7.0  # Relaxed: big SI = already well-protected
            print(f"DEBUG: SI={si_numeric} >= {HIGH_SI_THRESHOLD} (50L) → Using relaxed threshold 7.0")
        else:
            GOOD_COVERAGE_THRESHOLD = 7.5  # Standard threshold
            print(f"DEBUG: SI={si_numeric} < {HIGH_SI_THRESHOLD} (50L) → Using standard threshold 7.5")

        if current_score >= GOOD_COVERAGE_THRESHOLD:
            result["coverage_verdict"] = "good"
            result["recommendations"] = []  # Clear recommendations for well-covered plans
            print(f"DEBUG: Score {current_score} >= {GOOD_COVERAGE_THRESHOLD} → coverage_verdict='good', recommendations suppressed.")
        else:
            result["coverage_verdict"] = "needs_improvement"
            print(f"DEBUG: Score {current_score} < {GOOD_COVERAGE_THRESHOLD} → coverage_verdict='needs_improvement', recommendations shown.")

        try:
            company_stats_map = {}
            # Load CSR data
            try:
                with open("company_performance_ratios.csv", "r", encoding="utf-8", errors="replace") as f:
                    reader = csv.reader(f)
                    next(reader) # Header 1
                    next(reader) # Header 2
                    for row in reader:
                        if len(row) > 15: # Ensure row has all columns
                            # Clean name: remove special chars, lowercase
                            name_key = row[0].strip().lower().replace("company", "").replace("co.", "").replace("ltd.", "").replace("ltd", "").replace("general insurance", "").replace("health insurance", "").replace("insurance", "").strip()
                            try:
                                company_stats_map[name_key] = {
                                    "csr": row[1].strip(),
                                    "csr_rank": row[2].strip() if row[2].strip() else "N/A",
                                    "complaints": row[8].strip() if row[8].strip() else "N/A",
                                    "complaints_rank": row[9].strip() if row[9].strip() else "N/A",
                                    "solvency": row[14].strip() if row[14].strip() else "N/A",
                                    "solvency_rank": row[15].strip() if row[15].strip() else "N/A",
                                }
                            except:
                                pass
            except: 
                pass

            # Update current policy stats from CSV directly
            if "current_policy_stats" in result:
                current_comp = result["current_policy_stats"].get("company", data.get("company", "")).lower().replace("company", "").replace("co.", "").replace("ltd.", "").replace("ltd", "").replace("general insurance", "").replace("health insurance", "").replace("insurance", "").strip()
                
                matched_current = None
                if current_comp in company_stats_map:
                    matched_current = company_stats_map[current_comp]
                else:
                    c_name_no_spaces = current_comp.replace(" ", "")
                    # Special override for strict matching "Care"
                    if c_name_no_spaces == "care" and "carehealth" in company_stats_map:
                         matched_current = company_stats_map["carehealth"]
                    elif c_name_no_spaces == "carehealth" and "carehealth" in company_stats_map:
                         matched_current = company_stats_map["carehealth"]
                    else:
                        for k, v in company_stats_map.items():
                            k_no_spaces = k.replace(" ", "")
                            if len(k_no_spaces) > 3 and (k_no_spaces in c_name_no_spaces or c_name_no_spaces in k_no_spaces):
                                matched_current = v
                                break
                                
                if matched_current:
                    result["current_policy_stats"]["csr"] = matched_current["csr"]
                    result["current_policy_stats"]["csr_rank"] = matched_current["csr_rank"]
                    result["current_policy_stats"]["solvency"] = matched_current["solvency"]
                    result["current_policy_stats"]["solvency_rank"] = matched_current["solvency_rank"]
                    result["current_policy_stats"]["complaints"] = matched_current["complaints"]
                    result["current_policy_stats"]["complaints_rank"] = matched_current["complaints_rank"]

            if "recommendations" in result:
                # Iterate each category and inject stats per item
                for cat in result["recommendations"]:
                    if "items" in cat:
                        for rec in cat["items"]:
                            c_name = rec.get("company", "").lower().replace("company", "").replace("co.", "").replace("ltd.", "").replace("ltd", "").replace("general insurance", "").replace("health insurance", "").replace("insurance", "").strip()
                            
                            # Find matched stats
                            matched_stats = None
                            # Try exact match
                            if c_name in company_stats_map:
                                matched_stats = company_stats_map[c_name]
                            else:
                                # Try fuzzy containment (ignore spaces)
                                c_name_no_spaces = c_name.replace(" ", "")
                                for k, v in company_stats_map.items():
                                    k_no_spaces = k.replace(" ", "")
                                    if k_no_spaces in c_name_no_spaces or c_name_no_spaces in k_no_spaces:
                                        matched_stats = v
                                        break
                                        
                            if matched_stats:
                                rec["stats"] = matched_stats
                            else:
                                rec["stats"] = {
                                    "csr": "N/A", "csr_rank": "-", 
                                    "solvency": "N/A", "solvency_rank": "-", 
                                    "complaints": "N/A", "complaints_rank": "-"
                                }

        except Exception as e:
             print(f"Sorting Error: {e}") 

        # --- SUPABASE DATABASE INSERT ---
        if user and supabase_client:
            try:
                user_id = user.get("sub")
                
                # [SAFETY] Ensure profile exists before inserting analysis (Foreign Key constraint)
                profile_check = supabase_client.table("profiles").select("id").eq("id", user_id).execute()
                if not profile_check.data:
                    print(f"⚠️ Profile missing for user {user_id}. Creating fallback profile...")
                    supabase_client.table("profiles").insert({
                        "id": user_id,
                        "role": "client",
                        "full_name": user.get("email", "New User").split("@")[0]
                    }).execute()

                print("💾 Saving complete Analysis Report to Supabase Database...")
                
                # --- NEW: Generate Admin Summary ---
                admin_summary = generate_admin_summary(data, result, user_profile)
                result["admin_summary"] = admin_summary
                
                insert_data = {
                    "user_id": user.get("sub"),
                    "company_name": data.get("company", "Unknown"),
                    "plan_name": data.get("plan", "Unknown"),
                    "extracted_data": data, # The original extracted policy data
                    "report_data": result,   # The newly generated report including admin summary
                    "pdf_file_url": data.get("pdf_file_url")
                }
                db_res = supabase_client.table("policy_analyses").insert(insert_data).execute()
                
                # Attach the DB insert ID to the result so the frontend can use it for chats
                if db_res.data and len(db_res.data) > 0:
                    result["db_analysis_id"] = db_res.data[0].get("id")
                    print(f"✅ Analysis saved successfully! Database ID: {result['db_analysis_id']}")
                    
            except Exception as e:
                print(f"❌ Supabase DB Insert Error: {e}")
                # Don't fail the request if DB insert fails

        print("\n✅ [API] /api/compare COMPLETED SUCCESSFULLY!\n")
        return result # Changed from res_json to result to match existing variable name
    except HTTPException as he:
        raise he
    except Exception as e:
        print(f"COMPARISON ERROR: {str(e)}")
        raise HTTPException(status_code=500, detail=str(e))

def build_chat_context(policy_data: dict, report_data: dict) -> str:
    """Creates a compressed summary of policy data for the chatbot's system prompt."""
    
    # 1. Compress Policy Data (skip huge verbatim quotes and redundant info)
    features = policy_data.get("features_found", {})
    clean_features = {k: v for k, v in features.items() if str(v) != "Not Explicitly Mentioned"}
    
    summary_policy = {
        "company": policy_data.get("company"),
        "plan": policy_data.get("plan"),
        "sum_insured": policy_data.get("sum_insured", {}).get("total", "Unknown"),
        "premium": policy_data.get("premium", "Unknown"),
        "key_features": clean_features,
        "waiting_periods": policy_data.get("waiting_period_status", {})
    }

    # 2. Compress Report Data (extract just the final stats and recommendations)
    summary_report = {
        "product_score": report_data.get("product_score", 0),
        "pros": report_data.get("pros", []),
        "cons": report_data.get("cons", []),
        "recommendations": []
    }
    
    for cat in report_data.get("recommendations", []):
        cat_info = {"category": cat.get("category"), "options": []}
        for item in cat.get("items", []):
             cat_info["options"].append({
                 "company": item.get("company"),
                 "plan": item.get("name"),
                 "premium": item.get("premium"),
                 "primary_reason": item.get("description"),
             })
        summary_report["recommendations"].append(cat_info)

    return f"===== COMPRESSED POLICY SUMMARY =====\n{json.dumps(summary_policy, indent=2)}\n\n===== COMPRESSED REPORT SUMMARY =====\n{json.dumps(summary_report, indent=2)}"


@app.post("/api/chat")
async def chat_with_report(data: dict, user: dict = Depends(get_current_user)):
    try:
        user_message = data.get("message", "").strip()
        policy_data = data.get("policy", {})
        report_data = data.get("report", {})
        chat_history = data.get("history", [])
        analysis_id = data.get("analysis_id")

        if analysis_id and (not policy_data or not report_data):
            try:
                res = supabase_client.table("policy_analyses").select("extracted_data, report_data").eq("id", analysis_id).single().execute()
                if res.data:
                    policy_data = policy_data or res.data.get("extracted_data", {})
                    report_data = report_data or res.data.get("report_data", {})
            except Exception as e:
                print(f"Failed to fetch analysis data for chat: {e}")

        if not user_message:
            raise HTTPException(status_code=400, detail="Message is required.")

        # Compress context using new structured memory function
        compressed_context = build_chat_context(policy_data, report_data)

        # Construct System Context
        system_context = f"""
        Act as PolicyWise, an expert AI health insurance advisor.
        The user has uploaded their existing policy: "{policy_data.get('company', 'Unknown')}" - "{policy_data.get('plan', 'Unknown')}".
        Using the compressed data below, answer the user's questions.

        {compressed_context}

        === INSTRUCTIONS ===
        1. Act as a knowledgeable health insurance advisor. Answer the user's question accurately. If the question is about the provided Extracted Policy Details and Analysis Report, use that data. If the question is about general health insurance plans or other specific policies (like HDFC Ergo, etc., even if the uploaded policy is "Unknown"), provide a helpful, expert response based on your general knowledge.
        2. Be concise, professional, and empathetic. 
        3. Do not invent new insurance plans or recommend companies that were blocked (Niva Bupa, Care Health, Star Health).
        4. If the user asks something entirely outside the scope of health insurance, politely guide them back.
        5. Format your response clearly using markdown (bullet points, bold text for emphasis).
        6. IMPORTANT: DO NOT wrap your response in a JSON object or array. DO NOT use `{{"answer": "..."}}`. Output only plain markdown text.
        """

        # Construct Chat History for Gemini API
        contents = [system_context]
        
        # Append previous conversation history
        for msg in chat_history:
             role = "user" if msg.get("role") == "user" else "model"
             contents.append(types.Content(role=role, parts=[types.Part.from_text(text=msg.get("text", ""))]))
             
        # Add the latest user message
        contents.append(types.Content(role="user", parts=[types.Part.from_text(text=user_message)]))

        try:
             # We can use a slightly more conversational model for chat, but sticking to candidates is safer.
             # We won't strictly enforce json response here.
             response = await generate_content_with_fallback(
                 client,
                 contents=contents,
                 temperature=0.4,
                 response_mime_type="text/plain"
             )
             
             reply_text = response.text.strip()
             
        except Exception as e:
            reply_text = f"An error occurred while generating the response: {str(e)}"

        # --- SUPABASE CHAT LOGGING & TITLE GENERATION ---
        reply_title = None
        is_first_message = len(chat_history) == 0

        try:
            analysis_id = data.get("analysis_id")
            chat_db_id = data.get("chat_db_id") # Specific UUID for this conversation thread
            
            if user and supabase_client:
                chat_inserted_or_updated = False
                target_chat_id = None

                # 1. First Priority: Update by specific Chat UUID
                if chat_db_id:
                    try:
                        # Append new messages locally for update
                        updated_history = chat_history + [{"role": "user", "text": user_message}, {"role": "ai", "text": reply_text}]
                        supabase_client.table("chats").update({"chat_history": updated_history}).eq("id", chat_db_id).execute()
                        chat_inserted_or_updated = True
                        target_chat_id = chat_db_id
                    except:
                        pass

                # 2. Second Priority: If no specific UUID, but it's an analysis-linked chat...
                if not chat_inserted_or_updated and analysis_id:
                    # Always try to generate an intelligent title if it's the first message of a new chat
                    if is_first_message:
                        title_prompt = f"Summarize this insurance query into a 3-5 word short title. Query: {user_message}"
                        try:
                            title_res = await generate_content_with_fallback(client, contents=[title_prompt], temperature=0.2, response_mime_type="text/plain")
                            reply_title = title_res.text.strip().replace('"', '')
                        except:
                            reply_title = user_message[:30] + "..."

                    # Check if we should update an existing "Primary" chat for this analysis
                    # We only auto-update if it's NOT a "New Chat" (history not empty)
                    if not is_first_message:
                        chat_res = supabase_client.table("chats").select("id, chat_history, title").eq("analysis_id", analysis_id).execute()
                        if chat_res.data and len(chat_res.data) > 0:
                            chat_id = chat_res.data[0].get("id")
                            existing_history = chat_res.data[0].get("chat_history", [])
                            if not isinstance(existing_history, list): existing_history = []
                            existing_history.append({"role": "user", "text": user_message})
                            existing_history.append({"role": "ai", "text": reply_text})
                            
                            supabase_client.table("chats").update({"chat_history": existing_history}).eq("id", chat_id).execute()
                            if reply_title: 
                                supabase_client.table("chats").update({"title": reply_title}).eq("id", chat_id).execute()
                            
                            chat_inserted_or_updated = True
                            target_chat_id = chat_id

                # 3. Third Priority: Insert as new record
                if not chat_inserted_or_updated:
                    # Generate title for new record if not already done
                    if not reply_title and is_first_message:
                         title_prompt = f"Summarize this insurance query into a 3-5 word short title. Query: {user_message}"
                         try:
                             title_res = await generate_content_with_fallback(client, contents=[title_prompt], temperature=0.2, response_mime_type="text/plain")
                             reply_title = title_res.text.strip().replace('"', '')
                         except:
                             reply_title = user_message[:30] + "..."

                    new_history = [{"role": "user", "text": user_message}, {"role": "ai", "text": reply_text}]
                    insert_data = {"user_id": user.get("sub"), "chat_history": new_history}
                    if analysis_id: insert_data["analysis_id"] = analysis_id
                    if reply_title: insert_data["title"] = reply_title
                        
                    res = supabase_client.table("chats").insert(insert_data).execute()
                    if res.data and len(res.data) > 0:
                        target_chat_id = res.data[0].get("id")
                        
            return {"reply": reply_text, "title": reply_title, "chat_id": target_chat_id}
        except Exception as e:
            print(f"Supabase Chat Log Error: {e}")
            return {"reply": reply_text, "title": reply_title}
    except HTTPException as he:
        raise he
    except Exception as e:
        print(f"CHAT ERROR: {str(e)}")
        raise HTTPException(status_code=500, detail="Failed to process chat request.")

@app.get("/api/chats/{analysis_id}")
async def get_chats_for_analysis(analysis_id: str, user: dict = Depends(get_current_user)):
    """Fetches chat history for an analysis using the backend Service Role key, bypassing RLS."""
    if not user:
        raise HTTPException(status_code=401, detail="Authentication required")
        
    if not supabase_client:
        raise HTTPException(status_code=500, detail="Supabase client not initialized")
        
    try:
        # Assuming the backend SUPABASE_KEY is the service_role key, it bypasses RLS policies.
        # Check if the user is authorized. For now, any authenticated user can read this if they have the ID
        # In a strict production system, you'd verify if the user is an admin or the owner.
        
        # We verify if the user reading is either the owner or an admin
        profile_res = supabase_client.table("profiles").select("role").eq("id", user.get("sub")).execute()
        is_admin = False
        if profile_res.data and len(profile_res.data) > 0:
             is_admin = profile_res.data[0].get("role") == "admin"
             
        analysis_res = supabase_client.table("policy_analyses").select("user_id").eq("id", analysis_id).execute()
        is_owner = False
        if analysis_res.data and len(analysis_res.data) > 0:
             is_owner = analysis_res.data[0].get("user_id") == user.get("sub")
             
        if not is_admin and not is_owner:
             raise HTTPException(status_code=403, detail="Not authorized to view these chats")

        chat_res = supabase_client.table("chats").select("id, title, chat_history, updated_at").eq("analysis_id", analysis_id).order("updated_at", desc=True).execute()
        
        return chat_res.data if chat_res.data else []
        
    except HTTPException as he:
        raise he
    except Exception as e:
        print(f"❌ Error fetching chats: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to fetch chats: {str(e)}")

@app.delete("/api/analysis/{analysis_id}")
async def delete_analysis(analysis_id: str, user: dict = Depends(get_current_user)):
    """Deletes an analysis and its associated PDF from storage."""
    if not user:
        raise HTTPException(status_code=401, detail="Authentication required")
        
    if not supabase_client:
        raise HTTPException(status_code=500, detail="Supabase client not initialized")
        
    try:
        user_id = user.get("sub")
        
        # 1. Check if user is Admin or Owner
        profile_res = supabase_client.table("profiles").select("role").eq("id", user_id).execute()
        is_admin = False
        if profile_res.data and len(profile_res.data) > 0:
            is_admin = profile_res.data[0].get("role") == "admin"
            
        # Select user_id and extracted_data (since pdf_file_url is stored inside JSONB)
        analysis_res = supabase_client.table("policy_analyses").select("user_id, extracted_data").eq("id", analysis_id).execute()
        
        if not analysis_res.data:
            raise HTTPException(status_code=404, detail="Analysis not found")
            
        analysis = analysis_res.data[0]
        is_owner = analysis.get("user_id") == user_id
        
        if not is_admin and not is_owner:
            raise HTTPException(status_code=403, detail="Not authorized to delete this analysis")
            
        # 2. Delete file from Storage if exists
        extracted_data = analysis.get("extracted_data") or {}
        pdf_url = extracted_data.get("pdf_file_url")
        if pdf_url:
            try:
                # Extract path from URL: https://[project-id].supabase.co/storage/v1/object/public/policy_pdfs/[path]
                if "/public/policy_pdfs/" in pdf_url:
                    path = urllib.parse.unquote(pdf_url.split("/public/policy_pdfs/")[1])
                    print(f"🗑️ Deleting PDF from storage: {path}")
                    res = supabase_client.storage.from_("policy_pdfs").remove([path])
                    print(f"✅ PDF deleted from storage.")
            except Exception as e:
                 print(f"⚠️ Failed to delete PDF from storage: {e}")
                 
        # 3. Delete associated chats from Database
        try:
            supabase_client.table("chats").delete().eq("analysis_id", analysis_id).execute()
            print(f"✅ Associated chats for analysis {analysis_id} deleted.")
        except Exception as e:
            print(f"⚠️ Failed to delete associated chats: {e}")

        # 4. Delete row from Database
        delete_res = supabase_client.table("policy_analyses").delete().eq("id", analysis_id).execute()
        print(f"✅ Analysis row {analysis_id} deleted from database.")
        
        return {"message": "Analysis deleted successfully"}
    
    except HTTPException as he:
        raise he
    except Exception as e:
        print(f"❌ Error deleting analysis {analysis_id}: {str(e)}")
        raise HTTPException(status_code=500, detail=f"Failed to delete analysis: {str(e)}")

@app.delete("/api/user/self")
async def delete_self(user: dict = Depends(get_current_user)):
    """Deletes the currently authenticated user's account."""
    if not user:
        raise HTTPException(status_code=401, detail="Authentication required")
        
    user_id = user.get("sub")
    if not supabase_client:
        raise HTTPException(status_code=500, detail="Supabase client not initialized")
        
    try:
        # Use the admin client (Service Role key) to delete the user from auth.users
        # Note: Profiles and other tables will cascade delete due to foreign key constraints in our schema.
        print(f"🗑️ Request to delete user account: {user_id}")
        
        # In supabase-py, auth.admin.delete_user requires the service role key
        supabase_client.auth.admin.delete_user(user_id)
        
        print(f"✅ User {user_id} deleted successfully.")
        return {"message": "Account deleted successfully"}
        
    except Exception as e:
        print(f"❌ Error deleting user: {e}")
        raise HTTPException(status_code=500, detail=f"Failed to delete account: {str(e)}")


if __name__ == "__main__":
    import uvicorn
    reload_enabled = os.getenv("UVICORN_RELOAD", "").lower() in {"1", "true", "yes", "on"}
    uvicorn.run(
        "main:app",
        host=os.getenv("HOST", "127.0.0.1"),
        port=int(os.getenv("PORT", "8000")),
        reload=reload_enabled,
    )
