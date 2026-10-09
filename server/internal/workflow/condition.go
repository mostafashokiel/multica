package workflow

import (
	"fmt"
	"strings"
	"unicode"
)

// Condition expressions decide which way a condition stage goes:
//
//	or     := and ("or" and)*
//	and    := not ("and" not)*
//	not    := "not" not | atom
//	atom   := "(" or ")" | "has_label" "(" string ")"
//	string := '"' ... '"' | "'" ... "'"      (a backslash escapes the next character)
//
// Keywords are lowercase. Nesting and length are bounded so a hostile
// expression cannot exhaust the stack.
const (
	maxConditionDepth  = 64
	maxConditionLength = 2000
)

// Condition is a parsed expression.
type Condition struct {
	kind        string // "has_label", "not", "and", "or"
	label       string
	left, right *Condition
}

// ConditionError locates a syntax error.
type ConditionError struct {
	Message string
	Column  int // 1-based
}

func (e *ConditionError) Error() string { return fmt.Sprintf("%s (column %d)", e.Message, e.Column) }

type token struct {
	kind   string // "(", ")", "word", "string", "end"
	value  string
	column int
}

func tokenize(src []rune) ([]token, *ConditionError) {
	var out []token
	for i := 0; i < len(src); {
		c, column := src[i], i+1
		switch {
		case unicode.IsSpace(c):
			i++
		case c == '(' || c == ')':
			out = append(out, token{kind: string(c), column: column})
			i++
		case c == '"' || c == '\'':
			var sb strings.Builder
			i++
			closed := false
			for i < len(src) {
				switch {
				case src[i] == '\\' && i+1 < len(src):
					sb.WriteRune(src[i+1])
					i += 2
				case src[i] == c:
					i++
					closed = true
				default:
					sb.WriteRune(src[i])
					i++
				}
				if closed {
					break
				}
			}
			if !closed {
				return nil, &ConditionError{"Unterminated string", column}
			}
			out = append(out, token{kind: "string", value: sb.String(), column: column})
		case c == '_' || (c < unicode.MaxASCII && unicode.IsLetter(c)):
			start := i
			for i < len(src) && (src[i] == '_' || (src[i] < unicode.MaxASCII && (unicode.IsLetter(src[i]) || unicode.IsDigit(src[i])))) {
				i++
			}
			out = append(out, token{kind: "word", value: string(src[start:i]), column: column})
		default:
			return nil, &ConditionError{fmt.Sprintf("Unexpected character %q", string(c)), column}
		}
	}
	return out, nil
}

func describe(t token) string {
	switch t.kind {
	case "end":
		return "end of expression"
	case "word":
		return fmt.Sprintf("%q", t.value)
	case "string":
		return "a string"
	}
	return fmt.Sprintf("%q", t.kind)
}

type conditionParser struct {
	tokens []token
	pos    int
}

func (p *conditionParser) peek() token { return p.tokens[p.pos] }

func (p *conditionParser) next() token {
	t := p.tokens[p.pos]
	if t.kind != "end" {
		p.pos++
	}
	return t
}

func (p *conditionParser) isWord(w string) bool {
	t := p.peek()
	return t.kind == "word" && t.value == w
}

// ParseCondition parses an expression, reporting where it went wrong.
func ParseCondition(source string) (*Condition, *ConditionError) {
	if len([]rune(source)) > maxConditionLength {
		return nil, &ConditionError{fmt.Sprintf("Expression is longer than %d characters", maxConditionLength), 1}
	}
	runes := []rune(source)
	tokens, err := tokenize(runes)
	if err != nil {
		return nil, err
	}
	tokens = append(tokens, token{kind: "end", column: len(runes) + 1})
	p := &conditionParser{tokens: tokens}
	c, err := p.or(0)
	if err != nil {
		return nil, err
	}
	if t := p.peek(); t.kind != "end" {
		return nil, &ConditionError{"Unexpected " + describe(t), t.column}
	}
	return c, nil
}

func (p *conditionParser) or(depth int) (*Condition, *ConditionError) {
	left, err := p.and(depth)
	if err != nil {
		return nil, err
	}
	for p.isWord("or") {
		p.next()
		right, err := p.and(depth)
		if err != nil {
			return nil, err
		}
		left = &Condition{kind: "or", left: left, right: right}
	}
	return left, nil
}

func (p *conditionParser) and(depth int) (*Condition, *ConditionError) {
	left, err := p.not(depth)
	if err != nil {
		return nil, err
	}
	for p.isWord("and") {
		p.next()
		right, err := p.not(depth)
		if err != nil {
			return nil, err
		}
		left = &Condition{kind: "and", left: left, right: right}
	}
	return left, nil
}

func (p *conditionParser) not(depth int) (*Condition, *ConditionError) {
	if depth > maxConditionDepth {
		return nil, &ConditionError{"Expression is nested too deeply", p.peek().column}
	}
	if p.isWord("not") {
		p.next()
		operand, err := p.not(depth + 1)
		if err != nil {
			return nil, err
		}
		return &Condition{kind: "not", left: operand}, nil
	}
	return p.atom(depth)
}

func (p *conditionParser) atom(depth int) (*Condition, *ConditionError) {
	t := p.next()
	switch {
	case t.kind == "(":
		inner, err := p.or(depth + 1)
		if err != nil {
			return nil, err
		}
		if closing := p.next(); closing.kind != ")" {
			return nil, &ConditionError{fmt.Sprintf("Expected \")\" but found %s", describe(closing)), closing.column}
		}
		return inner, nil
	case t.kind == "word" && t.value == "has_label":
		if open := p.next(); open.kind != "(" {
			return nil, &ConditionError{fmt.Sprintf("Expected \"(\" but found %s", describe(open)), open.column}
		}
		label := p.next()
		if label.kind != "string" {
			return nil, &ConditionError{fmt.Sprintf("has_label needs a quoted label but found %s", describe(label)), label.column}
		}
		if label.value == "" {
			return nil, &ConditionError{"has_label needs a non-empty label", label.column}
		}
		if closing := p.next(); closing.kind != ")" {
			return nil, &ConditionError{fmt.Sprintf("Expected \")\" but found %s", describe(closing)), closing.column}
		}
		return &Condition{kind: "has_label", label: label.value}, nil
	case t.kind == "end":
		return nil, &ConditionError{"Expression ended early", t.column}
	}
	return nil, &ConditionError{fmt.Sprintf("Expected has_label(...), \"not\" or \"(\" but found %s", describe(t)), t.column}
}

// Evaluate reports whether the condition holds for an issue with these labels.
func (c *Condition) Evaluate(labels map[string]bool) bool {
	switch c.kind {
	case "has_label":
		return labels[c.label]
	case "not":
		return !c.left.Evaluate(labels)
	case "and":
		return c.left.Evaluate(labels) && c.right.Evaluate(labels)
	default:
		return c.left.Evaluate(labels) || c.right.Evaluate(labels)
	}
}
