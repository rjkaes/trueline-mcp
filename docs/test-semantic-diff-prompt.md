# Test Prompt: Semantic Diff

Use this in a separate Claude Code session pointed at a test project to
exercise `trueline_changes`. Copy the setup commands first, then paste the
test prompt.

## Setup (run in a temp directory)

```bash
mkdir /tmp/sdiff-test && cd /tmp/sdiff-test
git init && git config user.email test@test.com && git config user.name Test

cat > math.ts << 'EOF'
function add(a: number, b: number): number {
  return a + b;
}

function subtract(a: number, b: number): number {
  return a - b;
}

function multiply(a: number, b: number): number {
  return a * b;
}

class Calculator {
  private history: number[] = [];

  compute(op: string, a: number, b: number): number {
    let result: number;
    switch (op) {
      case "add": result = add(a, b); break;
      case "sub": result = subtract(a, b); break;
      case "mul": result = multiply(a, b); break;
      default: throw new Error("unknown op");
    }
    this.history.push(result);
    return result;
  }
}
EOF

cat > utils.ts << 'EOF'
export function formatNumber(n: number): string {
  return n.toFixed(2);
}

export function parseInput(s: string): number {
  return Number.parseFloat(s);
}
EOF

git add . && git commit -m "initial"
```

Now apply changes that exercise each detection category:

```bash
cat > math.ts << 'EOF'
function add(a: number, b: number): number {
  return a + b;
}

function divide(a: number, b: number): number {
  if (b === 0) throw new Error("division by zero");
  return a / b;
}

function multiply(x: number, y: number): number {
  return x * y;
}

class Calculator {
  private history: number[] = [];

  compute(op: string, a: number, b: number): number {
    let result: number;
    switch (op) {
      case "add": result = add(a, b); break;
      case "div": result = divide(a, b); break;
      case "mul": result = multiply(a, b); break;
      default: throw new Error(`unknown op: ${op}`);
    }
    this.history.push(result);
    return result;
  }

  getHistory(): number[] {
    return [...this.history];
  }
}
EOF

cat > utils.ts << 'EOF'
export function formatResult(n: number): string {
  return n.toFixed(2);
}

export function parseInput(s: string): number {
  const n = Number.parseFloat(s);
  if (Number.isNaN(n)) throw new Error("invalid input");
  return n;
}
EOF

cat > data.json << 'EOF'
{"version": 2}
EOF
```

## Test Prompt

Paste this into a Claude Code session in `/tmp/sdiff-test`:

---

Use `trueline_changes` to review my changes. Try these scenarios:

1. Diff `math.ts` against HEAD
2. Diff `utils.ts` against HEAD
3. Diff all changed files with `["*"]`
4. Diff `data.json` (should report unsupported)

For math.ts, I expect to see:
- `subtract` removed
- `divide` added
- `multiply` signature changed (param names)
- `Calculator.compute` logic modified (switch cases changed)
- `Calculator.getHistory` added
- `formatNumber` renamed to `formatResult` (same body)

For utils.ts, I expect to see:
- `parseInput` logic modified (added NaN check)

Tell me what the tool actually reports vs these expectations.

---

## What to verify

| Category | File | Expected |
|----------|------|----------|
| Added | math.ts | `divide`, `getHistory` |
| Removed | math.ts | `subtract` |
| Renamed | utils.ts | `formatNumber` -> `formatResult` |
| Signature changed | math.ts | `multiply` (param names) |
| Logic modified | math.ts | `compute` (switch body) |
| Logic modified | utils.ts | `parseInput` (NaN check) |
| Unsupported | data.json | "not supported" message |
| Wildcard | `["*"]` | Shows both .ts files |
