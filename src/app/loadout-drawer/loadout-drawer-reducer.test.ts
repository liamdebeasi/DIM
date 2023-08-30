import { D2ManifestDefinitions } from 'app/destiny2/d2-definitions';
import { DimItem } from 'app/inventory/item-types';
import { DimStore } from 'app/inventory/store-types';
import { isClassCompatible, itemCanBeEquippedBy, itemCanBeInLoadout } from 'app/utils/item-utils';
import { count } from 'app/utils/util';
import { DestinyClass } from 'bungie-api-ts/destiny2';
import { BucketHashes } from 'data/d2/generated-enums';
import _ from 'lodash';
import { getTestDefinitions, getTestStores } from 'testing/test-utils';
import { addItem } from './loadout-drawer-reducer';
import { Loadout } from './loadout-types';
import { newLoadout } from './loadout-utils';

let defs: D2ManifestDefinitions;
let store: DimStore;
// Items that could be in a Hunter loadout
let items: DimItem[];
// All items, even ones that couldn't be in a Hunter loadout
let allItems: DimItem[];
const emptyLoadout = newLoadout('Test', [], DestinyClass.Hunter);

beforeAll(async () => {
  let stores: DimStore[];
  [defs, stores] = await Promise.all([getTestDefinitions(), getTestStores()]);
  allItems = stores.flatMap((store) => store.items);
  const isValidItem = (store: DimStore, item: DimItem) =>
    itemCanBeEquippedBy(item, store) &&
    itemCanBeInLoadout(item) &&
    isClassCompatible(item.classType, DestinyClass.Hunter);
  store = _.maxBy(stores, (store) => count(allItems, (item) => isValidItem(store, item)))!;
  items = allItems.filter((item) => isValidItem(store, item));
});

describe('addItem', () => {
  it('can add an item to an empty loadout', () => {
    const item = items[0];
    const loadout = addItem(defs, item)(emptyLoadout);

    expect(loadout.items).toMatchObject([
      {
        amount: 1,
        equip: true,
        hash: item.hash,
        id: item.id,
      },
    ]);
  });

  it('saves the crafted date for crafted items', () => {
    const item = items.find((i) => i.crafted)!;
    expect(item).toBeDefined();
    const loadout = addItem(defs, item)(emptyLoadout);

    expect(loadout.items[0].craftedDate).toBeDefined();
  });

  it('can add an item to a loadout that is already there as a noop', () => {
    const item = items[0];
    let loadout = addItem(defs, item)(emptyLoadout);
    loadout = addItem(defs, item)(loadout);

    expect(loadout.items).toStrictEqual(loadout.items);
  });

  it('can add an unequipped item to a loadout', () => {
    const item = items[0];
    const loadoutAdded = addItem(defs, item, false)(emptyLoadout);

    expect(loadoutAdded.items.length).toBe(1);
    expect(loadoutAdded.items[0].equip).toBe(false);
  });

  it('defaults equip when unset', () => {
    const [item, item2] = items;

    let loadout = addItem(defs, item)(emptyLoadout);
    loadout = addItem(defs, item2)(loadout);

    expect(loadout.items).toMatchObject([
      {
        equip: true,
        id: item.id,
      },
      {
        equip: false,
        id: item2.id,
      },
    ]);
  });

  it('can replace the currently equipped item', () => {
    const [item, item2] = items;

    let loadout = addItem(defs, item, true)(emptyLoadout);
    loadout = addItem(defs, item2, true)(loadout);

    expect(loadout.items).toMatchObject([
      {
        equip: false,
        id: item.id,
      },
      {
        equip: true,
        id: item2.id,
      },
    ]);
  });

  it('can switch an equipped item to unequipped if added again with the equip flag set', () => {
    const item = items[0];

    let loadout = addItem(defs, item, true)(emptyLoadout);
    loadout = addItem(defs, item, false)(loadout);

    expect(loadout.items).toMatchObject([
      {
        equip: false,
        id: item.id,
      },
    ]);
  });

  it('can switch an unequipped item to equipped if added again with the equip flag set', () => {
    const item = items[0];

    let loadout = addItem(defs, item, false)(emptyLoadout);
    loadout = addItem(defs, item, true)(loadout);

    expect(loadout.items).toMatchObject([
      {
        equip: true,
        id: item.id,
      },
    ]);
  });

  it('fills in socket overrides when adding a subclass', () => {
    const subclass = items.find((i) => i.bucket.hash === BucketHashes.Subclass)!;

    let loadout = addItem(defs, subclass)(emptyLoadout);

    expect(loadout.items[0].socketOverrides).toBeDefined();
  });

  it('replaces the existing subclass when adding a new one', () => {
    const [subclass, subclass2] = items.filter((i) => i.bucket.hash === BucketHashes.Subclass);

    let loadout = addItem(defs, subclass)(emptyLoadout);
    loadout = addItem(defs, subclass2)(loadout);

    expect(loadout.items).toMatchObject([
      {
        id: subclass2.id,
      },
    ]);
  });

  it('does nothing if the item cannot be in a loadout', () => {
    const invalidItem = store.items.find((i) => !itemCanBeInLoadout(i))!;
    expect(invalidItem).toBeDefined();

    let loadout = addItem(defs, invalidItem)(emptyLoadout);

    expect(loadout.items).toEqual([]);
  });

  it('does nothing if the item is for the wrong class', () => {
    const invalidItem = allItems.find((i) => !isClassCompatible(i.classType, DestinyClass.Hunter))!;
    expect(invalidItem).toBeDefined();

    let loadout = addItem(defs, invalidItem)(emptyLoadout);

    expect(loadout.items).toEqual([]);
  });

  it('does nothing if the item cannot be in a loadout', () => {
    const invalidItem = allItems.find((i) => !itemCanBeInLoadout(i))!;
    expect(invalidItem).toBeDefined();

    let loadout = addItem(defs, invalidItem)(emptyLoadout);

    expect(loadout.items).toEqual([]);
  });

  it('does nothing if the bucket is already at capacity', () => {
    const weapons = items.filter((i) => i.bucket.hash === BucketHashes.KineticWeapons)!;
    expect(weapons.length).toBeGreaterThan(10);

    let loadout: Loadout | undefined;
    for (const item of weapons) {
      loadout = addItem(defs, item)(loadout ?? emptyLoadout);
    }

    expect(loadout!.items.length).toEqual(10);
  });
});
