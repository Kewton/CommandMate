#!/bin/bash
#
# Test script for rotate_logs() function in build-and-start.sh
# Validates log rotation behavior in an isolated temp directory.
#
# Usage:
#   ./tests/scripts/test-rotate-logs.sh
#
# Exit codes:
#   0 - All tests passed
#   1 - One or more tests failed

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
BUILD_SCRIPT="$PROJECT_DIR/scripts/build-and-start.sh"

TESTS_RUN=0
TESTS_PASSED=0
TESTS_FAILED=0

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m' # No Color

pass() {
    TESTS_PASSED=$((TESTS_PASSED + 1))
    echo -e "  ${GREEN}PASS${NC}: $1"
}

fail() {
    TESTS_FAILED=$((TESTS_FAILED + 1))
    echo -e "  ${RED}FAIL${NC}: $1"
}

run_test() {
    TESTS_RUN=$((TESTS_RUN + 1))
    echo "Test $TESTS_RUN: $1"
}

# Setup: create temp directory and extract rotate_logs function
setup() {
    TEST_TMPDIR=$(mktemp -d)
    TEST_LOG_DIR="$TEST_TMPDIR/logs"
    mkdir -p "$TEST_LOG_DIR"

    # Extract constants and rotate_logs function from build-and-start.sh
    # We source a snippet that defines the variables and function
    cat > "$TEST_TMPDIR/test-env.sh" << 'SETUP_EOF'
#!/bin/bash
# Override variables for testing
LOG_FILE="$TEST_LOG_DIR/server.log"
MAX_LOG_SIZE_MB=10
MAX_LOG_GENERATIONS=3
SETUP_EOF

    # Extract rotate_logs function from build-and-start.sh
    # We look for the function definition and extract it
    if grep -q 'rotate_logs()' "$BUILD_SCRIPT"; then
        # Extract function using awk: from "rotate_logs() {" to closing "}"
        awk '
            /^rotate_logs\(\)/ { found=1 }
            found { print; if (/^}$/) { exit } }
        ' "$BUILD_SCRIPT" > "$TEST_TMPDIR/rotate-func.sh"
        if [ -s "$TEST_TMPDIR/rotate-func.sh" ] && grep -q 'rotate_logs' "$TEST_TMPDIR/rotate-func.sh"; then
            FUNC_EXTRACTED=true
        else
            FUNC_EXTRACTED=false
        fi
    else
        FUNC_EXTRACTED=false
    fi
}

teardown() {
    if [ -n "$TEST_TMPDIR" ] && [ -d "$TEST_TMPDIR" ]; then
        rm -rf "$TEST_TMPDIR"
    fi
}

# Helper: create a file of a specific size in MB
create_file_mb() {
    local filepath="$1"
    local size_mb="$2"
    dd if=/dev/zero of="$filepath" bs=1048576 count="$size_mb" 2>/dev/null
}

# Helper: create a file of a specific size in bytes
create_file_bytes() {
    local filepath="$1"
    local size_bytes="$2"
    dd if=/dev/zero of="$filepath" bs=1 count="$size_bytes" 2>/dev/null
}

# Helper: source the test environment and function
source_rotate() {
    LOG_FILE="$TEST_LOG_DIR/server.log"
    export LOG_FILE TEST_LOG_DIR
    source "$TEST_TMPDIR/test-env.sh"
    source "$TEST_TMPDIR/rotate-func.sh"
}

# =============================================================
# Test 0: Function exists in build-and-start.sh
# =============================================================
test_function_exists() {
    run_test "rotate_logs() function exists in build-and-start.sh"
    if grep -q 'rotate_logs()' "$BUILD_SCRIPT"; then
        pass "rotate_logs() function found"
    else
        fail "rotate_logs() function NOT found in build-and-start.sh"
    fi
}

# =============================================================
# Test 1: Constants are defined
# =============================================================
test_constants_defined() {
    run_test "MAX_LOG_SIZE_MB and MAX_LOG_GENERATIONS constants are defined"
    if grep -q 'MAX_LOG_SIZE_MB=10' "$BUILD_SCRIPT" && grep -q 'MAX_LOG_GENERATIONS=3' "$BUILD_SCRIPT"; then
        pass "Constants defined correctly"
    else
        fail "Constants not found or incorrect values"
    fi
}

# =============================================================
# Test 2: rotate_logs call is present with error handling pattern
# =============================================================
test_rotate_call_present() {
    run_test "rotate_logs is called with || echo WARNING pattern"
    if grep -q 'rotate_logs || echo.*WARNING.*Log rotation failed' "$BUILD_SCRIPT"; then
        pass "rotate_logs call with failure-safe pattern found"
    else
        fail "rotate_logs call with failure-safe pattern NOT found"
    fi
}

# =============================================================
# Test 3: chmod 640 is added after nohup for log file permissions [S4-005]
# =============================================================
test_chmod_640_present() {
    run_test "chmod 640 for LOG_FILE is present after nohup [S4-005]"
    if grep -q 'chmod 640.*LOG_FILE' "$BUILD_SCRIPT"; then
        pass "chmod 640 found for LOG_FILE [S4-005]"
    else
        fail "chmod 640 for LOG_FILE NOT found [S4-005]"
    fi
}

# =============================================================
# Test 4: Log file does not exist -> early return (no error)
# =============================================================
test_no_logfile() {
    run_test "No log file exists -> early return with exit code 0"
    if [ "$FUNC_EXTRACTED" != "true" ]; then
        fail "rotate_logs function not extracted, skipping"
        return
    fi
    # Ensure no log file exists
    rm -f "$TEST_LOG_DIR/server.log"
    (
        source_rotate
        rotate_logs
    )
    local rc=$?
    if [ $rc -eq 0 ]; then
        pass "Early return with code 0 when no log file"
    else
        fail "Expected exit code 0, got $rc"
    fi
}

# =============================================================
# Test 5: Log file under threshold -> no rotation
# =============================================================
test_under_threshold() {
    run_test "Log file under threshold (5MB < 10MB) -> no rotation"
    if [ "$FUNC_EXTRACTED" != "true" ]; then
        fail "rotate_logs function not extracted, skipping"
        return
    fi
    create_file_mb "$TEST_LOG_DIR/server.log" 5
    (
        source_rotate
        rotate_logs
    )
    if [ -f "$TEST_LOG_DIR/server.log" ] && [ ! -f "$TEST_LOG_DIR/server.log.1" ]; then
        pass "No rotation performed for undersized file"
    else
        fail "Rotation should not have occurred"
    fi
}

# =============================================================
# Test 6: Log file over threshold -> rotation to .1
# =============================================================
test_basic_rotation() {
    run_test "Log file over threshold (15MB > 10MB) -> rotated to .1"
    if [ "$FUNC_EXTRACTED" != "true" ]; then
        fail "rotate_logs function not extracted, skipping"
        return
    fi
    # Clean up
    rm -f "$TEST_LOG_DIR/server.log"*
    create_file_mb "$TEST_LOG_DIR/server.log" 15
    (
        source_rotate
        rotate_logs
    )
    if [ ! -f "$TEST_LOG_DIR/server.log" ] && [ -f "$TEST_LOG_DIR/server.log.1" ]; then
        pass "server.log rotated to server.log.1"
    else
        fail "Expected server.log to be moved to server.log.1"
    fi
}

# =============================================================
# Test 7: Generation shift with existing .1, .2, .3
# =============================================================
test_generation_shift() {
    run_test "Generation shift: .3 deleted, .2->.3, .1->.2, current->.1"
    if [ "$FUNC_EXTRACTED" != "true" ]; then
        fail "rotate_logs function not extracted, skipping"
        return
    fi
    # Clean up and create files
    rm -f "$TEST_LOG_DIR/server.log"*
    create_file_mb "$TEST_LOG_DIR/server.log" 15
    echo "gen1" > "$TEST_LOG_DIR/server.log.1"
    echo "gen2" > "$TEST_LOG_DIR/server.log.2"
    echo "gen3" > "$TEST_LOG_DIR/server.log.3"
    (
        source_rotate
        rotate_logs
    )
    # Verify: .3 should now contain old .2 content
    local new3_content
    new3_content=$(cat "$TEST_LOG_DIR/server.log.3" 2>/dev/null)
    local new2_content
    new2_content=$(cat "$TEST_LOG_DIR/server.log.2" 2>/dev/null)
    if [ "$new3_content" = "gen2" ] && [ "$new2_content" = "gen1" ] && [ -f "$TEST_LOG_DIR/server.log.1" ] && [ ! -f "$TEST_LOG_DIR/server.log" ]; then
        pass "Generation shift performed correctly"
    else
        fail "Generation shift did not produce expected results"
        echo "    .1 exists: $([ -f "$TEST_LOG_DIR/server.log.1" ] && echo yes || echo no)"
        echo "    .2 content: '$new2_content' (expected 'gen1')"
        echo "    .3 content: '$new3_content' (expected 'gen2')"
        echo "    server.log exists: $([ -f "$TEST_LOG_DIR/server.log" ] && echo yes || echo no)"
    fi
}

# =============================================================
# Test 8: Symlink guard [S4-006] - LOG_FILE is symlink
# =============================================================
test_symlink_guard_logfile() {
    run_test "Symlink guard [S4-006]: LOG_FILE is a symlink -> return 1"
    if [ "$FUNC_EXTRACTED" != "true" ]; then
        fail "rotate_logs function not extracted, skipping"
        return
    fi
    rm -f "$TEST_LOG_DIR/server.log"*
    # Create a real file and a symlink
    echo "real" > "$TEST_LOG_DIR/real.log"
    ln -s "$TEST_LOG_DIR/real.log" "$TEST_LOG_DIR/server.log"
    local rc=0
    (
        source_rotate
        rotate_logs
    ) 2>/dev/null || rc=$?
    if [ $rc -ne 0 ]; then
        pass "Symlink detected, returned non-zero"
    else
        fail "Expected non-zero return for symlink LOG_FILE"
    fi
    # Cleanup
    rm -f "$TEST_LOG_DIR/server.log" "$TEST_LOG_DIR/real.log"
}

# =============================================================
# Test 9: Symlink guard [S4-006] - generation file is symlink
# =============================================================
test_symlink_guard_generation() {
    run_test "Symlink guard [S4-006]: generation file is a symlink -> return 1"
    if [ "$FUNC_EXTRACTED" != "true" ]; then
        fail "rotate_logs function not extracted, skipping"
        return
    fi
    rm -f "$TEST_LOG_DIR/server.log"*
    create_file_mb "$TEST_LOG_DIR/server.log" 15
    echo "real" > "$TEST_LOG_DIR/real.log"
    ln -s "$TEST_LOG_DIR/real.log" "$TEST_LOG_DIR/server.log.1"
    local rc=0
    (
        source_rotate
        rotate_logs
    ) 2>/dev/null || rc=$?
    if [ $rc -ne 0 ]; then
        pass "Symlink in generation file detected, returned non-zero"
    else
        fail "Expected non-zero return for symlink generation file"
    fi
    # Cleanup
    rm -f "$TEST_LOG_DIR/server.log"* "$TEST_LOG_DIR/real.log"
}

# =============================================================
# Test 10: rotate_logs call is positioned before db:init
# =============================================================
test_call_before_dbinit() {
    run_test "rotate_logs call is positioned before db:init and after chmod 755"
    local rotate_line
    local dbinit_line
    local chmod_line
    # Match the call site (rotate_logs ||), not the function definition (rotate_logs() {)
    rotate_line=$(grep -n 'rotate_logs ||' "$BUILD_SCRIPT" | head -1 | cut -d: -f1)
    # Match "npm run db:init" (actual command), not help text references
    dbinit_line=$(grep -n '^npm run db:init' "$BUILD_SCRIPT" | head -1 | cut -d: -f1)
    chmod_line=$(grep -n 'chmod 755.*DATA_DIR' "$BUILD_SCRIPT" | head -1 | cut -d: -f1)

    if [ -z "$rotate_line" ] || [ -z "$dbinit_line" ] || [ -z "$chmod_line" ]; then
        fail "Could not find required lines"
        return
    fi

    if [ "$rotate_line" -gt "$chmod_line" ] && [ "$rotate_line" -lt "$dbinit_line" ]; then
        pass "rotate_logs positioned correctly (after chmod, before db:init)"
    else
        fail "rotate_logs not in correct position (chmod:$chmod_line, rotate:$rotate_line, dbinit:$dbinit_line)"
    fi
}

# =============================================================
# Main
# =============================================================
main() {
    echo ""
    echo "=== rotate_logs() Test Suite ==="
    echo ""

    setup

    # Structural tests (always run)
    test_function_exists
    test_constants_defined
    test_rotate_call_present
    test_chmod_640_present
    test_call_before_dbinit

    # Functional tests (require function extraction)
    if [ "$FUNC_EXTRACTED" = "true" ]; then
        test_no_logfile
        # Reset temp dir between tests
        rm -f "$TEST_LOG_DIR/server.log"*
        test_under_threshold
        rm -f "$TEST_LOG_DIR/server.log"*
        test_basic_rotation
        rm -f "$TEST_LOG_DIR/server.log"*
        test_generation_shift
        rm -f "$TEST_LOG_DIR/server.log"*
        test_symlink_guard_logfile
        rm -f "$TEST_LOG_DIR/server.log"*
        test_symlink_guard_generation
    else
        echo ""
        echo "  (Skipping functional tests: rotate_logs() not yet implemented)"
        echo ""
    fi

    teardown

    echo ""
    echo "=== Results ==="
    echo "  Total:  $TESTS_RUN"
    echo "  Passed: $TESTS_PASSED"
    echo "  Failed: $TESTS_FAILED"
    echo ""

    if [ $TESTS_FAILED -gt 0 ]; then
        echo -e "${RED}FAILED${NC}"
        exit 1
    else
        echo -e "${GREEN}ALL TESTS PASSED${NC}"
        exit 0
    fi
}

main
