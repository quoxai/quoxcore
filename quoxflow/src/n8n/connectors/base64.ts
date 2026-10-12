/**
 * Inline base64 encoder for generated expressions.
 *
 * QuoxFlow's expression engine exposes `$.base64Encode` (src/
 * expression/engine.ts), but it's implemented with `btoa()`, which
 * isn't defined in the isolated-vm sandbox the engine actually
 * evaluates expressions in — that helper is currently dead code
 * ("btoa is not defined" at runtime). Fixing it is a core-engine
 * change and out of scope for this converter-layer work, so any
 * connector that needs base64 (Gmail's raw MIME body) embeds a small,
 * self-contained, UTF-8-safe base64 encoder directly in the generated
 * expression instead of depending on `$.base64Encode`.
 */
export function inlineBase64Expr(jsStringSource: string): string {
  return (
    `(function(s){` +
    `var b='ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/',y=[],o='',i,c;` +
    `for(i=0;i<s.length;i++){c=s.charCodeAt(i);` +
    `if(c<128)y.push(c);` +
    `else if(c<2048){y.push(192|(c>>6),128|(c&63));}` +
    `else{y.push(224|(c>>12),128|((c>>6)&63),128|(c&63));}}` +
    `for(i=0;i<y.length;i+=3){` +
    `var b1=y[i],b2=y[i+1],b3=y[i+2],` +
    `e1=b1>>2,e2=((b1&3)<<4)|((b2||0)>>4),` +
    `e3=b2===undefined?64:(((b2&15)<<2)|((b3||0)>>6)),` +
    `e4=b3===undefined?64:(b3&63);` +
    `o+=b.charAt(e1)+b.charAt(e2)+b.charAt(e3)+b.charAt(e4);}` +
    `return o;})(${jsStringSource})`
  );
}
