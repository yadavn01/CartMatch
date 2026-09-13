// Print PAK'nSAVE and New World store lists so you can fill in config/stores.json.
//
//   npm run stores:foodstuffs                # all stores
//   npm run stores:foodstuffs -- auckland    # filter by name/address (case-insensitive)

import { FoodstuffsClient } from "../clients/foodstuffs.mjs";

const filter = process.argv.slice(2).join(" ").toLowerCase();

for (const banner of ["paknsave", "newworld"]) {
  const stores = await new FoodstuffsClient(banner).listStores();
  const shown = filter
    ? stores.filter((s) => `${s.name} ${s.address}`.toLowerCase().includes(filter))
    : stores;
  console.log(`\n${banner} — ${shown.length}/${stores.length} stores`);
  for (const s of shown) {
    console.log(`  { "id": "${s.id}", "name": ${JSON.stringify(s.name)} },  // ${s.address}`);
  }
}
