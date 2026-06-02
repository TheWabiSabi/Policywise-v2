@echo off
echo Starting Backend...

REM Check if venv exists
if not exist ".venv" (
    echo Virtual environment not found! Please create it first.
    pause
    exit /b
)

REM Activate the virtual environment using the batch script
REM This avoids PowerShell execution policy restrictions
call .venv\Scripts\activate.bat

REM Upgrade pip just in case (optional, good practice)
python -m pip install --upgrade pip

REM Install requirements
echo Installing/Updating requirements...
pip install -r requirements.txt

REM Run the application
echo Running main.py...
python main.py

pause
