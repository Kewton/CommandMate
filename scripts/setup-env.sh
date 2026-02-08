#!/bin/bash
#
# CommandMate - Environment Setup Script
# Interactive .env file generator
#
# Usage:
#   ./scripts/setup-env.sh
#   ./scripts/setup-env.sh -h
#

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Script version
VERSION="1.0.0"

# Default values
DEFAULT_PORT="3000"
DEFAULT_BIND="127.0.0.1"
DEFAULT_DB_PATH="./data/cm.db"
DEFAULT_LOG_LEVEL="info"
DEFAULT_LOG_FORMAT="text"

# Show help
show_help() {
    cat << EOF
CommandMate Environment Setup v${VERSION}

Usage: $(basename "$0") [OPTIONS]

Options:
    -h, --help      Show this help message
    -v, --version   Show version
    -y, --yes       Non-interactive mode (use defaults where possible)

Description:
    Interactively generates a .env configuration file for CommandMate.
    If a .env file already exists, it will be backed up before generating a new one.

Environment Variables Configured:
    - CM_ROOT_DIR       Repository root directory (required)
    - CM_PORT           Server port (default: 3000)
    - CM_BIND           Bind address (default: 127.0.0.1)
    - CM_DB_PATH        Database path (default: ./data/cm.db)
    - CM_LOG_LEVEL      Log level (default: info)
    - CM_LOG_FORMAT     Log format (default: text)

Backup:
    If .env already exists, it will be backed up to .env.backup.{timestamp}

EOF
}

# Show version
show_version() {
    echo "CommandMate Environment Setup v${VERSION}"
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

# Logging functions
log_info() {
    echo -e "$1"
}

log_success() {
    echo -e "${GREEN}✓${NC} $1"
}

log_error() {
    echo -e "${RED}✗${NC} $1" >&2
}

log_warning() {
    echo -e "${YELLOW}⚠${NC} $1"
}

log_prompt() {
    echo -e "${CYAN}?${NC} $1"
}

# Read user input with default
read_input() {
    local prompt="$1"
    local default="$2"
    local var_name="$3"
    local result

    if [ -n "$default" ]; then
        log_prompt "$prompt [$default]: "
    else
        log_prompt "$prompt: "
    fi

    if [ "$NON_INTERACTIVE" = true ]; then
        result="$default"
        echo "$result"
    else
        read -r result
        if [ -z "$result" ]; then
            result="$default"
        fi
    fi

    eval "$var_name=\"$result\""
}

# Read yes/no input
read_yesno() {
    local prompt="$1"
    local default="$2"  # y or n
    local var_name="$3"
    local result

    if [ "$default" = "y" ]; then
        log_prompt "$prompt (Y/n): "
    else
        log_prompt "$prompt (y/N): "
    fi

    if [ "$NON_INTERACTIVE" = true ]; then
        result="$default"
        echo "$result"
    else
        read -r result
        result=$(echo "$result" | tr '[:upper:]' '[:lower:]')
        if [ -z "$result" ]; then
            result="$default"
        fi
    fi

    if [ "$result" = "y" ] || [ "$result" = "yes" ]; then
        eval "$var_name=true"
    else
        eval "$var_name=false"
    fi
}

# Backup existing .env
backup_env() {
    if [ -f .env ]; then
        local timestamp
        timestamp=$(date +%Y%m%d%H%M%S)
        local backup_file=".env.backup.${timestamp}"
        cp .env "$backup_file"
        log_success "Existing .env backed up to ${backup_file}"
    fi
}

# Main function
main() {
    log_info ""
    log_info "=================================="
    log_info "CommandMate Environment Setup"
    log_info "=================================="
    log_info ""

    # Backup existing .env if exists
    if [ -f .env ]; then
        log_warning "Existing .env file found"
        backup_env
        log_info ""
    fi

    # Required: CM_ROOT_DIR
    log_info "--- Required Settings ---"
    log_info ""

    local root_dir
    local default_root="$HOME/repos"
    read_input "Repository root directory (CM_ROOT_DIR)" "$default_root" root_dir

    if [ -z "$root_dir" ]; then
        log_error "CM_ROOT_DIR is required"
        exit 1
    fi

    # Expand ~ to home directory
    root_dir="${root_dir/#\~/$HOME}"

    log_info ""

    # Optional: Port
    log_info "--- Server Settings ---"
    log_info ""

    local port
    read_input "Server port (CM_PORT)" "$DEFAULT_PORT" port

    log_info ""

    # Optional: External access
    local enable_external
    read_yesno "Enable external access (bind to 0.0.0.0)?" "n" enable_external

    local bind_address="$DEFAULT_BIND"

    if [ "$enable_external" = true ]; then
        bind_address="0.0.0.0"
        log_info ""
        log_success "External access enabled"
        log_info "    Bind address: 0.0.0.0"
        log_warning "IMPORTANT: Configure reverse proxy authentication before exposing to external networks."
        log_info "    See: docs/security-guide.md"
    fi

    log_info ""

    # Optional: Database path
    local db_path
    read_input "Database path (CM_DB_PATH)" "$DEFAULT_DB_PATH" db_path

    log_info ""

    # Advanced settings
    local configure_logging
    read_yesno "Configure advanced settings (logging)?" "n" configure_logging

    local log_level="$DEFAULT_LOG_LEVEL"
    local log_format="$DEFAULT_LOG_FORMAT"
    local log_dir=""

    if [ "$configure_logging" = true ]; then
        log_info ""
        log_info "--- Advanced Settings ---"
        log_info ""
        read_input "Log level (debug/info/warn/error)" "$DEFAULT_LOG_LEVEL" log_level
        read_input "Log format (text/json)" "$DEFAULT_LOG_FORMAT" log_format
        read_input "Log directory (leave empty for default)" "" log_dir
    fi

    log_info ""
    log_info "--- Generating .env ---"
    log_info ""

    # Generate .env file
    cat > .env << EOF
# CommandMate Environment Configuration
# Generated by setup-env.sh on $(date)

# ===================================
# Server Configuration
# ===================================

# Root directory for worktree scanning
CM_ROOT_DIR=${root_dir}

# Server port (default: 3000)
CM_PORT=${port}

# Bind address
# - 127.0.0.1: Localhost only (development)
# - 0.0.0.0: All interfaces (production, reverse proxy auth recommended)
CM_BIND=${bind_address}

# ===================================
# Security
# ===================================

# When CM_BIND=0.0.0.0, use a reverse proxy (e.g., Nginx) with authentication.
# See: docs/security-guide.md

EOF

    cat >> .env << EOF
# ===================================
# Database
# ===================================

# SQLite database file path
CM_DB_PATH=${db_path}

# ===================================
# Logging
# ===================================

# Log level: debug, info, warn, error
CM_LOG_LEVEL=${log_level}

# Log format: text, json
CM_LOG_FORMAT=${log_format}

EOF

    if [ -n "$log_dir" ]; then
        cat >> .env << EOF
# Log directory
CM_LOG_DIR=${log_dir}

EOF
    fi

    cat >> .env << EOF
# ===================================
# Node Environment
# ===================================

NODE_ENV=development

# ===================================
# Legacy Support (Deprecated)
# ===================================
# The following MCBD_* variables are deprecated but still supported
# for backward compatibility. Please migrate to CM_* variables.
# See: docs/migration-to-commandmate.md

EOF

    log_success ".env file created successfully"
    log_info ""

    # Summary
    log_info "=================================="
    log_info "Configuration Summary"
    log_info "=================================="
    log_info ""
    log_info "  CM_ROOT_DIR:  ${root_dir}"
    log_info "  CM_PORT:      ${port}"
    log_info "  CM_BIND:      ${bind_address}"
    log_info "  CM_DB_PATH:   ${db_path}"
    log_info "  CM_LOG_LEVEL: ${log_level}"
    log_info ""

    log_info "Next steps:"
    log_info "  1. Review .env file if needed"
    log_info "  2. Run: npm run db:init"
    log_info "  3. Run: npm run build"
    log_info "  4. Run: ./scripts/build-and-start.sh --daemon"
    log_info ""
}

main
