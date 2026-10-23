import { createHash } from "node:crypto";
const [key, salt, txn] = process.argv.slice(2);
const hash = createHash("sha512")
  .update(`${key}|verify_payment|${txn}|${salt}`)
  .digest("hex");
const r = await fetch("https://test.payu.in/merchant/postservice.php?form=2", {
  method: "POST",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ key, command: "verify_payment", var1: txn, hash }),
});
console.log(r.status, await r.text());