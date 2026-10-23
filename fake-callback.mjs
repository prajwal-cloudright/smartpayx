import { createHash } from "node:crypto";
const [key, salt, txnid, attempt, amount, base] = process.argv.slice(2);
const p = {
  key, txnid, amount, status: "success", udf1: attempt,
  productinfo: "SmartPayX Order", firstname: "Akash Kumar", email: "test@example.com",
};
const seq = [salt, p.status, "", "", "", "", "", "", "", "", "", p.udf1,
  p.email, p.firstname, p.productinfo, p.amount, p.txnid, p.key];
p.hash = createHash("sha512").update(seq.join("|")).digest("hex");
const url = `${base}/callbacks/payu?attempt=${attempt}&origin=https://devstore-mcvja0e1.myshopify.com&path=/`;
const r = await fetch(url, { method: "POST", redirect: "manual",
  headers: { "Content-Type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(p) });
console.log(r.status, r.headers.get("location"));