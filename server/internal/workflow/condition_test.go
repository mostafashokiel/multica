package workflow

import (
	"strings"
	"testing"
)

func eval(t *testing.T, src string, labels ...string) bool {
	t.Helper()
	c, err := ParseCondition(src)
	if err != nil {
		t.Fatalf("%q: %v", src, err)
	}
	set := map[string]bool{}
	for _, l := range labels {
		set[l] = true
	}
	return c.Evaluate(set)
}

func TestConditionEvaluation(t *testing.T) {
	cases := []struct {
		src    string
		labels []string
		want   bool
	}{
		{`has_label("a")`, []string{"a"}, true},
		{`has_label('a')`, nil, false},
		{`not has_label("a")`, nil, true},
		{`not not has_label("a")`, []string{"a"}, true},
		{`has_label("a") and has_label("b")`, []string{"a"}, false},
		{`has_label("a") or has_label("b")`, []string{"b"}, true},
		// precedence: not > and > or
		{`has_label("a") or has_label("b") and not has_label("c")`, []string{"a", "c"}, true},
		{`has_label("a") or has_label("b") and not has_label("c")`, []string{"b", "c"}, false},
		{`( has_label("a")  or has_label("b") ) and has_label("c")`, []string{"b", "c"}, true},
		{`( has_label("a")  or has_label("b") ) and has_label("c")`, []string{"c"}, false},
		{`has_label("a\"b")`, []string{`a"b`}, true},
		{`has_label("a\\b")`, []string{`a\b`}, true},
	}
	for _, c := range cases {
		if got := eval(t, c.src, c.labels...); got != c.want {
			t.Errorf("%s with %v = %v, want %v", c.src, c.labels, got, c.want)
		}
	}
}

func TestConditionErrorsAreLocated(t *testing.T) {
	cases := []struct {
		src    string
		part   string
		column int
	}{
		{``, "Expression ended early", 1},
		{`   `, "Expression ended early", 4},
		{`has_label("a") and`, "Expression ended early", 19},
		{`has_label("a") has_label("b")`, `Unexpected "has_label"`, 16},
		{`has_label("a"`, `Expected ")"`, 14},
		{`has_label("")`, "non-empty", 11},
		{`has_label(a)`, "quoted label", 11},
		{`has_label("abc`, "Unterminated string", 11},
		{`has_label`, `Expected "("`, 10},
		{`HAS_LABEL("a")`, "Expected has_label", 1},
		{`has_label("a") AND has_label("b")`, "Unexpected", 16},
		{`has_label("a") && has_label("b")`, "Unexpected character", 16},
		{`(has_label("a")`, `Expected ")"`, 16},
		{`has_label("a"))`, `Unexpected ")"`, 15},
		{`foo`, "Expected has_label", 1},
		{`and`, "Expected has_label", 1},
		{`not`, "Expression ended early", 4},
	}
	for _, c := range cases {
		_, err := ParseCondition(c.src)
		if err == nil {
			t.Errorf("%q: expected an error", c.src)
			continue
		}
		if !strings.Contains(err.Message, c.part) || err.Column != c.column {
			t.Errorf("%q: got %q at column %d, want %q at column %d", c.src, err.Message, err.Column, c.part, c.column)
		}
	}
}

func TestConditionLimitsAndGarbage(t *testing.T) {
	for _, src := range []string{
		strings.Repeat("(", 5000) + `has_label("a")` + strings.Repeat(")", 5000),
		strings.Repeat("not ", 500) + `has_label("a")`,
		`has_label("` + strings.Repeat("x", 3000) + `")`,
	} {
		if _, err := ParseCondition(src); err == nil {
			t.Errorf("expected %.30q... to be rejected", src)
		}
	}
	for _, junk := range []string{"\x00", `"`, `'\`, "(((", ")))", `\`, `has_label("a\`, "💥"} {
		ParseCondition(junk) // must not panic
	}
}
