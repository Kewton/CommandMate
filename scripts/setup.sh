#!/bin/bash
#
# CommandMate - Production Setup Script
# This script helps set up the production environment
#
# Usage:
#   ./scripts/setup.sh
#   ./scripts/setup.sh -h
#

set -e

# Colors for output
GREEN='\033[0;32m'
NC='\033[0m' # No Color

# Script version
VERSION="2.0.0"

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# Show help
show_help() {
    cat << EOF
CommandMate Production Setup v${VERSION}

Usage: $(basename "$0") [OPTIONS]

Options:
    -h, --help      Show this help message
    -v, --version   Show version
    -y, --yes       Non-interactive mode (skip .env setup if exists)

Description:
    Sets up CommandMate for production use. This script will:
    1. Run preflight checks (dependencies)
    2. Install npm dependencies
    3. Configure environment (.env)
    4. Initialize database, build, and start application

After setup, the application will be running in the background.

EOF
}

# Show version
show_version() {
    echo "CommandMate Production Setup v${VERSION}"
}

# Parse arguments
NON_INTERACTIVE=false
while [[ $# -gt 0 ]]; do
    case $1 in
        -h|--help)
            show_help
            exit 0
            ;;
        -v|--version)
            show_version
            exit 0
            ;;
        -y|--yes)
            NON_INTERACTIVE=true
            shift
            ;;
        *)
            echo "Unknown option: $1"
            echo "Use -h for help"
            exit 1
            ;;
    esac
done

# Change to project directory
cd "$PROJECT_DIR"

echo "=================================="
echo "CommandMate Production Setup"
echo "=================================="
echo ""

# Step 1: Preflight check
echo "Step 1/5: Checking dependencies..."
if ! ./scripts/preflight-check.sh; then
    echo ""
    echo "ERROR: Preflight check failed. Please install missing dependencies."
    exit 1
fi
echo ""

# Step 2: Install dependencies
echo "Step 2/5: Installing npm dependencies..."
npm install
echo -e "${GREEN}✓${NC} Dependencies installed"
echo ""

# Step 3: Environment configuration
echo "Step 3/4: Configuring environment..."
if [ ! -f .env ]; then
    echo "No .env file found. Starting interactive setup..."
    echo ""
    if [ "$NON_INTERACTIVE" = true ]; then
        ./scripts/setup-env.sh -y
    else
        ./scripts/setup-env.sh
    fi
else
    echo -e "${GREEN}✓${NC} .env file already exists"
    echo "    (Run ./scripts/setup-env.sh to reconfigure)"
fi
echo ""

# Step 4: Build and start
echo "Step 4/4: Building and starting application..."
./scripts/build-and-start.sh --daemon
echo ""

# Final message
echo "=================================="
echo "Setup complete!"
echo "=================================="
echo ""
echo "The application is now running in the background."
echo ""
echo "Useful commands:"
echo "  ./scripts/status.sh        - Check application status"
echo "  ./scripts/health-check.sh  - Run health checks"
echo "  ./scripts/logs.sh          - View application logs"
echo "  ./scripts/stop-server.sh   - Stop the server"
echo "  ./scripts/restart.sh       - Restart the server"
echo ""
