import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/** Tiny JSON helper (string/number/bool/null + objects/arrays). Enough for Team C envelopes. */
final class Json {
    private Json() {}

    static String esc(String s) {
        if (s == null) return "null";
        StringBuilder b = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"' -> b.append("\\\"");
                case '\\' -> b.append("\\\\");
                case '\n' -> b.append("\\n");
                case '\r' -> b.append("\\r");
                case '\t' -> b.append("\\t");
                default -> b.append(c);
            }
        }
        return b.append('"').toString();
    }

    static String obj(Map<String, Object> map) {
        StringBuilder b = new StringBuilder("{");
        boolean first = true;
        for (Map.Entry<String, Object> e : map.entrySet()) {
            if (!first) b.append(',');
            first = false;
            b.append(esc(e.getKey())).append(':').append(val(e.getValue()));
        }
        return b.append('}').toString();
    }

    static String arr(List<?> list) {
        StringBuilder b = new StringBuilder("[");
        for (int i = 0; i < list.size(); i++) {
            if (i > 0) b.append(',');
            b.append(val(list.get(i)));
        }
        return b.append(']').toString();
    }

    @SuppressWarnings("unchecked")
    static String val(Object v) {
        if (v == null) return "null";
        if (v instanceof Number || v instanceof Boolean) return String.valueOf(v);
        if (v instanceof Map) return obj((Map<String, Object>) v);
        if (v instanceof List) return arr((List<?>) v);
        return esc(String.valueOf(v));
    }

    static Object parse(String s) {
        return new Parser(s).parseValue();
    }

    @SuppressWarnings("unchecked")
    static Map<String, Object> asObj(Object v) {
        return v instanceof Map ? (Map<String, Object>) v : Map.of();
    }

    @SuppressWarnings("unchecked")
    static List<Object> asArr(Object v) {
        return v instanceof List ? (List<Object>) v : List.of();
    }

    static String str(Object v) {
        return v == null ? null : String.valueOf(v);
    }

    static int num(Object v, int d) {
        if (v instanceof Number n) return n.intValue();
        if (v == null) return d;
        try { return (int) Double.parseDouble(String.valueOf(v)); }
        catch (Exception e) { return d; }
    }

    private static final class Parser {
        final String s;
        int i;

        Parser(String s) { this.s = s.trim(); }

        Object parseValue() {
            skip();
            if (i >= s.length()) return null;
            char c = s.charAt(i);
            if (c == '{') return parseObject();
            if (c == '[') return parseArray();
            if (c == '"') return parseString();
            if (c == 't' || c == 'f') return parseBool();
            if (c == 'n') { i += 4; return null; }
            return parseNumber();
        }

        Map<String, Object> parseObject() {
            Map<String, Object> m = new LinkedHashMap<>();
            i++;
            skip();
            if (peek('}')) { i++; return m; }
            while (i < s.length()) {
                skip();
                String k = parseString();
                skip();
                expect(':');
                Object v = parseValue();
                m.put(k, v);
                skip();
                if (peek('}')) { i++; break; }
                expect(',');
            }
            return m;
        }

        List<Object> parseArray() {
            List<Object> list = new ArrayList<>();
            i++;
            skip();
            if (peek(']')) { i++; return list; }
            while (i < s.length()) {
                list.add(parseValue());
                skip();
                if (peek(']')) { i++; break; }
                expect(',');
            }
            return list;
        }

        String parseString() {
            expect('"');
            StringBuilder b = new StringBuilder();
            while (i < s.length()) {
                char c = s.charAt(i++);
                if (c == '"') break;
                if (c == '\\' && i < s.length()) {
                    char n = s.charAt(i++);
                    b.append(switch (n) {
                        case 'n' -> '\n';
                        case 'r' -> '\r';
                        case 't' -> '\t';
                        default -> n;
                    });
                } else b.append(c);
            }
            return b.toString();
        }

        Object parseNumber() {
            int start = i;
            while (i < s.length() && "-+0123456789.eE".indexOf(s.charAt(i)) >= 0) i++;
            String n = s.substring(start, i);
            if (n.contains(".") || n.contains("e") || n.contains("E")) return Double.parseDouble(n);
            try { return Long.parseLong(n); }
            catch (Exception e) { return Double.parseDouble(n); }
        }

        Boolean parseBool() {
            if (s.startsWith("true", i)) { i += 4; return true; }
            i += 5;
            return false;
        }

        void skip() {
            while (i < s.length() && Character.isWhitespace(s.charAt(i))) i++;
        }

        boolean peek(char c) { return i < s.length() && s.charAt(i) == c; }

        void expect(char c) {
            skip();
            if (i >= s.length() || s.charAt(i) != c) throw new IllegalArgumentException("expected " + c);
            i++;
        }
    }
}
