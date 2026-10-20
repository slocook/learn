// A small, safe evaluator for numeric answers, so a learner can type "pi/6", "2*sqrt(3)",
// "atan2(1, 1)" or "1.2e-3 m" instead of working out decimals by hand.

const FUNCTIONS: Record<string, (...args: number[]) => number> = {
	sqrt: Math.sqrt,
	abs: Math.abs,
	sin: Math.sin,
	cos: Math.cos,
	tan: Math.tan,
	asin: Math.asin,
	acos: Math.acos,
	atan: Math.atan,
	atan2: Math.atan2,
	exp: Math.exp,
	ln: Math.log,
	log: Math.log10,
	log10: Math.log10,
	log2: Math.log2,
	deg: (r) => (r * 180) / Math.PI,
	rad: (d) => (d * Math.PI) / 180,
	min: Math.min,
	max: Math.max,
};

const CONSTANTS: Record<string, number> = { pi: Math.PI, π: Math.PI, e: Math.E, tau: 2 * Math.PI };

type Token = { kind: "num"; value: number } | { kind: "id"; value: string } | { kind: "op"; value: string };

function tokenize(src: string): Token[] {
	const tokens: Token[] = [];
	let i = 0;
	while (i < src.length) {
		const ch = src[i]!;
		if (/\s/.test(ch)) {
			i++;
		} else if (/[0-9.]/.test(ch)) {
			const m = /^(\d+\.?\d*|\.\d+)(e[+-]?\d+)?/i.exec(src.slice(i));
			if (!m) throw new Error(`bad number at "${src.slice(i)}"`);
			tokens.push({ kind: "num", value: Number(m[0]) });
			i += m[0].length;
		} else if (/[a-zπ_]/i.test(ch)) {
			const m = /^[a-zπ_][a-z0-9_]*/i.exec(src.slice(i))!;
			tokens.push({ kind: "id", value: m[0].toLowerCase() });
			i += m[0].length;
		} else if ("+-*/^(),".includes(ch)) {
			tokens.push({ kind: "op", value: ch });
			i++;
		} else if (ch === "°") {
			tokens.push({ kind: "op", value: "°" });
			i++;
		} else {
			throw new Error(`unexpected "${ch}"`);
		}
	}
	return tokens;
}

/** Evaluate an arithmetic expression. Throws on anything it does not understand. */
export function evaluate(src: string): number {
	const tokens = tokenize(src);
	let pos = 0;
	const peek = () => tokens[pos];
	const eat = (value?: string) => {
		const t = tokens[pos];
		if (!t || (value !== undefined && t.value !== value)) throw new Error(`expected "${value ?? "a value"}"`);
		pos++;
		return t;
	};
	const expr = (): number => {
		let v = term();
		while (peek()?.kind === "op" && (peek()!.value === "+" || peek()!.value === "-")) {
			v = eat().value === "+" ? v + term() : v - term();
		}
		return v;
	};
	const term = (): number => {
		let v = unary();
		for (;;) {
			const t = peek();
			if (t?.kind === "op" && (t.value === "*" || t.value === "/")) {
				eat();
				v = t.value === "*" ? v * unary() : v / unary();
			} else if (t && (t.kind === "num" || t.kind === "id" || t.value === "(")) {
				v *= unary(); // implicit multiplication: "2pi", "3 sqrt(2)"
			} else {
				return v;
			}
		}
	};
	const unary = (): number => {
		if (peek()?.value === "-") {
			eat();
			return -unary();
		}
		if (peek()?.value === "+") {
			eat();
			return unary();
		}
		return power();
	};
	const power = (): number => {
		let base = postfix();
		if (peek()?.value === "^") {
			eat();
			base = base ** unary();
		}
		return base;
	};
	const postfix = (): number => {
		let v = atom();
		while (peek()?.value === "°") {
			eat();
			v = (v * Math.PI) / 180;
		}
		return v;
	};
	const atom = (): number => {
		const t = eat();
		if (t.kind === "num") return t.value as number;
		if (t.kind === "op" && t.value === "(") {
			const v = expr();
			eat(")");
			return v;
		}
		if (t.kind === "id") {
			const name = t.value as string;
			if (name in CONSTANTS) return CONSTANTS[name]!;
			const fn = FUNCTIONS[name];
			if (!fn) throw new Error(`unknown name "${name}"`);
			eat("(");
			const args = [expr()];
			while (peek()?.value === ",") {
				eat();
				args.push(expr());
			}
			eat(")");
			return fn(...args);
		}
		throw new Error(`unexpected "${t.value}"`);
	};
	const value = expr();
	if (pos !== tokens.length) throw new Error(`unexpected "${tokens[pos]!.value}"`);
	return value;
}

/** Parse a learner's numeric answer, dropping a trailing unit if it matches the expected one. */
export function parseNumericAnswer(input: string, unit?: string): number {
	let text = input.trim().replace(/,(?=\d{3}\b)/g, "");
	if (unit) {
		const u = unit.trim();
		if (u && text.toLowerCase().endsWith(u.toLowerCase())) text = text.slice(0, -u.length).trim();
	}
	const value = evaluate(text);
	if (!Number.isFinite(value)) throw new Error("not a finite number");
	return value;
}
