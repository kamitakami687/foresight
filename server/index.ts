import app from "../server.js";

const PORT = process.env.PORT ? Number(process.env.PORT) : 3001;
app.listen(PORT, () => {
  console.log(`Foresight server listening on http://localhost:${PORT}`);
});
