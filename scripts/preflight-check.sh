#!/bin/bash
#
# CommandMate - Preflight Check Script
# Validates that all required dependencies are installed
#
# Usage:
#   ./scripts/preflight-check.sh
#   ./scripts/preflight-check.sh -h
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Script version
VERSION="1.0.0"

# Show help
show_help() {
    cat << EOF
CommandMate Preflight Check v${VERSION}

Usage: $(basename "$0") [OPTIONS]

Options:
    -h, --help      Show this help message
    -v, --version   Show version
    -q, --quiet     Quiet mode (only show errors)

Description:
    Checks that all required dependencies for CommandMate are installed.

Required Dependencies:
    - Node.js (v20+)
    - npm
    - tmux
    - git

Optional Dependencies:
    - Claude CLI (required for CLI session management features)

Exit Codes:
    0   All required dependencies are installed
    1   One or more required dependencies are missing

EOF
}

# Show version
show_version() {
    echo "CommandMate Preflight Check v${VERSION}"
}

# Parse arguments
QUIET=false
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
        -q|--quiet)
            QUIET=true
            shift
            ;;
        *)
            echo "Unknown option: $1"
            echo "Use -h for help"
            exit 1
            ;;
    esac
done

# Logging functions
log_info() {
    if [ "$QUIET" = false ]; then
        echo -e "$1"
    fi
}

log_success() {
    if [ "$QUIET" = false ]; then
        echo -e "${GREEN}✓${NC} $1"
    fi
}

log_error() {
    echo -e "${RED}✗${NC} $1" >&2
}

log_warning() {
    if [ "$QUIET" = false ]; then
        echo -e "${YELLOW}⚠${NC} $1"
    fi
}

# Check if a command exists
check_command() {
    command -v "$1" &> /dev/null
}

# Get version of a command
get_version() {
    case $1 in
        node)
            node -v 2>/dev/null | sed 's/v//'
            ;;
        npm)
            npm -v 2>/dev/null
            ;;
        tmux)
            tmux -V 2>/dev/null | awk '{print $2}'
            ;;
        git)
            git --version 2>/dev/null | awk '{print $3}'
            ;;
        claude)
            claude --version 2>/dev/null | head -1
            ;;
    esac
}

# Main check
main() {
    log_info ""
    log_info "=================================="
    log_info "CommandMate Preflight Check"
    log_info "=================================="
    log_info ""

    local has_error=false
    local has_warning=false

    # Check Node.js (required, v20+)
    if check_command node; then
        local node_version
        node_version=$(get_version node)
        local node_major
        node_major=$(echo "$node_version" | cut -d'.' -f1)
        if [ "$node_major" -ge 20 ]; then
            log_success "Node.js: v${node_version}"
        else
            log_error "Node.js: v${node_version} (v20+ required)"
            has_error=true
        fi
    else
        log_error "Node.js: not installed (v20+ required)"
        has_error=true
    fi

    # Check npm (required)
    if check_command npm; then
        local npm_version
        npm_version=$(get_version npm)
        log_success "npm: ${npm_version}"
    else
        log_error "npm: not installed"
        has_error=true
    fi

    # Check tmux (required)
    if check_command tmux; then
        local tmux_version
        tmux_version=$(get_version tmux)
        log_success "tmux: ${tmux_version}"
    else
        log_error "tmux: not installed"
        has_error=true
    fi

    # Check git (required)
    if check_command git; then
        local git_version
        git_version=$(get_version git)
        log_success "git: ${git_version}"
    else
        log_error "git: not installed"
        has_error=true
    fi

    # Check Claude CLI (optional but recommended)
    if check_command claude; then
        local claude_version
        claude_version=$(get_version claude)
        log_success "Claude CLI: ${claude_version}"
    else
        log_warning "Claude CLI: not installed"
        log_info "    (Core features require Claude CLI. Install later if needed)"
        has_warning=true
    fi

    log_info ""

    # Summary
    if [ "$has_error" = true ]; then
        log_info "=================================="
        log_error "Preflight check failed!"
        log_info "=================================="
        log_info ""
        log_info "Please install the missing dependencies and try again."
        log_info ""
        exit 1
    elif [ "$has_warning" = true ]; then
        log_info "=================================="
        log_success "Preflight check passed with warnings"
        log_info "=================================="
        log_info ""
    else
        log_info "=================================="
        log_success "All dependencies are installed"
        log_info "=================================="
        log_info ""
    fi

    exit 0
}

main
