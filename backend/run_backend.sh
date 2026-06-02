#!/bin/bash
echo "Starting Backend..."

# Check if venv exists
if [ ! -d "venv" ]; then
    echo "Virtual environment not found! Please create it first using: python3 -m venv venv"
    exit 1
fi

# Activate the virtual environment
source venv/bin/activate

# Install requirements
echo "Installing/Updating requirements..."
pip install -r requirements.txt

# Run the application
echo "Running main.py..."
python3 main.py
