import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const privateKey = generatePrivateKey();
const account = privateKeyToAccount(privateKey);

console.log(`ADDRESS=${account.address}`);
console.log(`PRIVATE_KEY=${privateKey}`);
