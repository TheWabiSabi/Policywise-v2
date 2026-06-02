# Policy Suggester App - Startup Guide

To run this project, you need two separate terminals open.

## 1. Start the Backend (API)
Open your first terminal and run the "Start Button" script:

**Windows:**
```powershell
backend\run_backend.bat
```

**Mac/Linux:**
```bash
backend/run_backend.sh
```

*(This safely activates the virtual environment and runs the app for you)*

---
**Alternative (Manual Way):**
```bash
cd backend
# Windows
Set-ExecutionPolicy -ExecutionPolicy RemoteSigned -Scope Process
.\venv\Scripts\Activate.ps1
# Mac
source venv/bin/activate

pip install -r requirements.txt
python main.py
```
*You will see a message like "Uvicorn running on http://127.0.0.1:8000"*

## 2. Start the Frontend (Website)
Open a **new, second terminal** and run these commands:

```bash
cd frontend
npm run dev
```
*You will see a message like "Local: http://localhost:5173/"*

## 3. Open in Browser
Go to **http://localhost:5173** in your web browser to use the app.
