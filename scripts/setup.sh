#!/bin/bash
#
# CommandMate - Production Setup Script
# This script helps set up the production environment
#

set -e

echo "=================================="
echo "CommandMate Production Setup"
echo "=================================="
echo ""

# Check Node.js version
echo "Checking Node.js version..."
NODE_VERSION=$(node -v | cut -d'v' -f2 | cut -d'.' -f1)
if [ "$NODE_VERSION" -lt 20 ]; then
  echo "ERROR: Node.js 20.x or higher is required (current: $(node -v))"
  exit 1
fi
echo "✓ Node.js $(node -v)"

# Check if .env exists
if [ ! -f .env ]; then
  echo ""
  echo "Creating .env file from .env.production.example..."
  if [ -f .env.production.example ]; then
    cp .env.production.example .env
    echo "✓ .env file created"
    echo ""
    echo "IMPORTANT: Please edit .env and configure the following:"
    echo "  - CM_ROOT_DIR: Path to your worktrees directory"
    echo "  - CM_AUTH_TOKEN: Generate with: openssl rand -hex 32"
    echo "  - CM_DB_PATH: Path to your production database"
    echo ""
    read -p "Press Enter to continue after editing .env..."
  else
    echo "ERROR: .env.production.example not found"
    exit 1
  fi
else
  echo "✓ .env file already exists"
fi

# Install dependencies
echo ""
echo "Installing dependencies..."
npm install
echo "✓ Dependencies installed"

# Create data directory
echo ""
echo "Creating data directory..."
mkdir -p data
chmod 755 data
echo "✓ Data directory created"

# Initialize database
echo ""
echo "Initializing database..."
npm run db:init
echo "✓ Database initialized"

# Build application
echo ""
echo "Building application..."
npm run build
echo "✓ Application built"

# Check if PM2 is installed
echo ""
if command -v pm2 &> /dev/null; then
  echo "✓ PM2 is installed"
  echo ""
  echo "To start the application with PM2:"
  echo "  ./scripts/start.sh"
else
  echo "! PM2 is not installed"
  echo ""
  echo "To install PM2:"
  echo "  npm install -g pm2"
  echo ""
  echo "Or start directly with:"
  echo "  npm start"
fi

echo ""
echo "=================================="
echo "Setup complete!"
echo "=================================="
echo ""
echo "Next steps:"
echo "  1. Edit .env and configure your environment"
echo "  2. Start the application:"
echo "     - With PM2: ./scripts/start.sh"
echo "     - Direct: npm start"
echo "  3. Check status: ./scripts/status.sh"
echo ""
