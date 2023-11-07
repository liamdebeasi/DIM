import { TagValue } from 'app/inventory/dim-item-info';
import { DimItem, PluggableInventoryItemDefinition } from 'app/inventory/item-types';
import { ModMap } from 'app/loadout/mod-assignment-utils';
import { chainComparator, compareBy } from 'app/utils/comparators';
import { getModTypeTagByPlugCategoryHash } from 'app/utils/item-utils';
import { infoLog } from 'app/utils/log';
import { releaseProxy, wrap } from 'comlink';
import { BucketHashes } from 'data/d2/generated-enums';
import _ from 'lodash';
import { ProcessItem, ProcessItemsByBucket, ProcessResult } from '../process-worker/types';
import {
  ArmorEnergyRules,
  ArmorSet,
  AutoModDefs,
  ItemGroup,
  ItemsByBucket,
  LockableBucketHash,
  ModStatChanges,
  ResolvedStatConstraint,
} from '../types';
import {
  hydrateArmorSet,
  mapArmor2ModToProcessMod,
  mapAutoMods,
  mapDimItemToProcessItem,
} from './mappers';

function createWorker() {
  const instance = new Worker(
    /* webpackChunkName: "lo-worker" */ new URL('../process-worker/ProcessWorker', import.meta.url),
  );

  const worker = wrap<import('../process-worker/ProcessWorker').ProcessWorker>(instance);

  const cleanup = () => {
    worker[releaseProxy]();
    instance.terminate();
  };

  return { worker, cleanup };
}

export function runProcess({
  autoModDefs,
  filteredItems,
  lockedModMap,
  modStatChanges,
  armorEnergyRules,
  resolvedStatConstraints,
  anyExotic,
  autoStatMods,
  getUserItemTag,
  strictUpgrades,
  stopOnFirstSet,
}: {
  autoModDefs: AutoModDefs;
  filteredItems: ItemsByBucket;
  lockedModMap: ModMap;
  modStatChanges: ModStatChanges;
  armorEnergyRules: ArmorEnergyRules;
  resolvedStatConstraints: ResolvedStatConstraint[];
  anyExotic: boolean;
  autoStatMods: boolean;
  getUserItemTag?: (item: DimItem) => TagValue | undefined;
  strictUpgrades: boolean;
  stopOnFirstSet: boolean;
}): {
  cleanup: () => void;
  resultPromise: Promise<Omit<ProcessResult, 'sets'> & { sets: ArmorSet[]; processTime: number }>;
} {
  const processStart = performance.now();
  const { worker, cleanup: cleanupWorker } = createWorker();
  let cleanupRef: (() => void) | undefined = cleanupWorker;
  const cleanup = () => {
    cleanupRef?.();
    cleanupRef = undefined;
  };

  const { bucketSpecificMods, activityMods, generalMods } = lockedModMap;

  const lockedProcessMods = {
    generalMods: generalMods.map(mapArmor2ModToProcessMod),
    activityMods: activityMods.map(mapArmor2ModToProcessMod),
  };

  const autoModsData = mapAutoMods(autoModDefs);

  const processItems: ProcessItemsByBucket = {
    [BucketHashes.Helmet]: [],
    [BucketHashes.Gauntlets]: [],
    [BucketHashes.ChestArmor]: [],
    [BucketHashes.LegArmor]: [],
    [BucketHashes.ClassArmor]: [],
  };
  const itemsById = new Map<string, ItemGroup>();

  for (const [bucketHashStr, items] of Object.entries(filteredItems)) {
    const bucketHash = parseInt(bucketHashStr, 10) as LockableBucketHash;
    processItems[bucketHash] = [];

    const groupedItems = mapItemsToGroups(
      items,
      resolvedStatConstraints,
      armorEnergyRules,
      activityMods,
      bucketSpecificMods[bucketHash] || [],
      getUserItemTag,
    );

    for (const group of groupedItems) {
      processItems[bucketHash].push(group.canonicalProcessItem);
      itemsById.set(group.canonicalProcessItem.id, group);
    }
  }

  // NB this looks like a no-op but what's sorted here aren't the array entries but the object keys.
  // Ensuring all array members have properties in the same order helps the JIT keep the code monomorphic...
  const sortedResolvedStatConstraints: ResolvedStatConstraint[] = resolvedStatConstraints.map(
    (c) => ({
      minTier: c.minTier,
      maxTier: c.maxTier,
      statHash: c.statHash,
      ignored: c.ignored,
    }),
  );

  // TODO: could potentially partition the problem (split the largest item category maybe) to spread across more cores

  return {
    cleanup,
    resultPromise: new Promise((resolve) => {
      const workerStart = performance.now();
      worker
        .process(
          processItems,
          _.mapValues(modStatChanges, (stat) => stat.value),
          lockedProcessMods,
          sortedResolvedStatConstraints,
          anyExotic,
          autoModsData,
          autoStatMods,
          strictUpgrades,
          stopOnFirstSet,
        )
        .then((result) => {
          infoLog(
            'loadout optimizer',
            `useProcess: worker time ${performance.now() - workerStart}ms`,
          );
          const hydratedSets = result.sets.map((set) => hydrateArmorSet(set, itemsById));
          const processTime = performance.now() - processStart;
          infoLog('loadout optimizer', `useProcess ${processTime}ms`);
          resolve({ ...result, sets: hydratedSets, processTime });
        })
        // Cleanup the worker, we don't need it anymore.
        .finally(() => {
          cleanup();
        });
    }),
  };
}

interface MappedItem {
  dimItem: DimItem;
  processItem: ProcessItem;
}

// comparator for sorting items in groups generated by groupItems. These items will all have the same stats.
const groupComparator = (getTag?: (item: DimItem) => TagValue | undefined) =>
  chainComparator(
    // Prefer higher-energy (ideally masterworked)
    compareBy(({ dimItem }: MappedItem) => -(dimItem.energy?.energyCapacity || 0)),
    // Prefer owned items over vendor items
    compareBy(({ dimItem }: MappedItem) => Boolean(dimItem.vendor)),
    // Prefer favorited items
    compareBy(({ dimItem }: MappedItem) => getTag?.(dimItem) !== 'favorite'),
    // Prefer items with higher power
    compareBy(({ dimItem }: MappedItem) => -dimItem.power),
    // Prefer items that are equipped
    compareBy(({ dimItem }: MappedItem) => (dimItem.equipped ? 0 : 1)),
  );

/**
 * To reduce the number of items sent to the web worker we group items by a number of varying
 * parameters, depending on what mods and armour upgrades are selected. This is purely an optimization
 * and most of the time only has an effect for class items, but this can be a significant improvement
 * when we only have to check 1-4 class items instead of 12.
 *
 * After items have been grouped we only send a single item (the first one) as a representative of
 * said group. All other grouped items will be available by the swap icon in the UI.
 *
 * An important property of this grouping is that all items within a single group must be interchangeable
 * for any possible assignment of mods.
 *
 * Creating a group for every item is trivially correct but inefficient. Erroneously forgetting to include a bit
 * of information in the grouping key that is relevant to the web worker results in the worker failing to discover
 * certain sets, or set rendering suddenly failing in unexpected ways when it prefers an alternative due to an existing
 * loadout, so everything in ProcessItem that affects the operation of the worker
 * must be accounted for in this function.
 *
 * It can group by any number of the following concepts depending on locked mods and armor upgrades,
 * - Stat distribution
 * - Masterwork status
 * - Exoticness (every exotic must be distinguished from other exotics and all legendaries)
 * - Energy capacity
 * - If there are mods with tags (activity/combat style) it will create groups split by compatible tags
 */
function mapItemsToGroups(
  items: readonly DimItem[],
  resolvedStatConstraints: ResolvedStatConstraint[],
  armorEnergyRules: ArmorEnergyRules,
  activityMods: PluggableInventoryItemDefinition[],
  modsForSlot: PluggableInventoryItemDefinition[],
  getUserItemTag?: (item: DimItem) => TagValue | undefined,
): ItemGroup[] {
  // Figure out all the interesting mod slots required by mods are.
  // This includes combat mod tags because blue-quality items don't have them
  // and there may be legacy items that can slot CWL/Warmind Cell mods but not
  // Elemental Well mods?
  const requiredModTags = new Set<string>();
  for (const mod of activityMods) {
    const modTag = getModTypeTagByPlugCategoryHash(mod.plug.plugCategoryHash);
    if (modTag) {
      requiredModTags.add(modTag);
    }
  }

  // First, map the DimItems to ProcessItems so that we can consider all things relevant to Loadout Optimizer.
  const mappedItems: MappedItem[] = items.map((dimItem) => ({
    dimItem,
    processItem: mapDimItemToProcessItem({ dimItem, armorEnergyRules, modsForSlot }),
  }));

  // First, group by exoticness to ensure exotics always form a distinct group
  const firstPassGroupingFn = ({ hash, isExotic }: ProcessItem) =>
    isExotic ? `${hash}-` : 'legendary-';

  // Second pass -- cache the worker-relevant information, except the one we used in the first pass.
  const cache = new Map<
    DimItem,
    {
      stats: number[];
      energyCapacity: number;
      relevantModSeasons: Set<string>;
      isArtifice: boolean;
    }
  >();
  for (const item of mappedItems) {
    // Id, name are not important, exoticness+hash were grouped by in phase 1.
    // Energy value is the same for all items.

    // Item stats are important for the stat results of a full set
    const statValues: number[] = resolvedStatConstraints.map(
      (c) => item.processItem.stats[c.statHash],
    );
    // Energy capacity affects mod assignment
    const energyCapacity = item.processItem.remainingEnergyCapacity;
    // Supported mod tags affect mod assignment
    const relevantModSeasons =
      item.processItem.compatibleModSeasons?.filter((season) => requiredModTags.has(season)) ?? [];
    relevantModSeasons.sort();

    cache.set(item.dimItem, {
      stats: statValues,
      energyCapacity,
      relevantModSeasons: new Set(relevantModSeasons),
      isArtifice: item.processItem.isArtifice,
    });
  }

  // Group items by everything relevant.
  const finalGroupingFn = (item: DimItem) => {
    const info = cache.get(item)!;
    return `${info.stats.toString()}-${info.energyCapacity}-${[
      ...info.relevantModSeasons.values(),
    ].toString()}`;
  };

  const energyGroups = Object.groupBy(mappedItems, ({ processItem }) =>
    firstPassGroupingFn(processItem),
  );

  // Final grouping by everything relevant
  const groups: ItemGroup[] = [];

  // Go through each grouping-by-energy-type, throw out any items with strictly worse properties than
  // another item in that group, then use what's left to build groups by their properties.
  for (const group of Object.values(energyGroups)) {
    const keepSet: MappedItem[] = [];

    // Checks if test is a superset of existing, i.e. every value of existing is contained in test
    const isSuperset = <T>(test: Set<T>, existing: Set<T>) =>
      [...existing.values()].every((v) => test.has(v));

    const isStrictlyBetter = (testItem: MappedItem, existingItem: MappedItem) => {
      const testInfo = cache.get(testItem.dimItem)!;
      const existingInfo = cache.get(existingItem.dimItem)!;

      const betterOrEqual =
        testInfo.stats.every((statValue, idx) => statValue >= existingInfo.stats[idx]) &&
        testInfo.energyCapacity >= existingInfo.energyCapacity &&
        (testItem.processItem.isArtifice || !existingInfo.isArtifice) &&
        isSuperset(testInfo.relevantModSeasons, existingInfo.relevantModSeasons);
      if (!betterOrEqual) {
        return false;
      }
      // The item is better or equal, so check if there are any differences -- if any of these properties are not equal
      // it means the item is better in one of these dimensions, so it must be strictly better.
      const isDifferent =
        testInfo.stats.some((statValue, idx) => statValue !== existingInfo.stats[idx]) ||
        testInfo.energyCapacity !== existingInfo.energyCapacity ||
        testInfo.isArtifice !== existingInfo.isArtifice ||
        testInfo.relevantModSeasons.size !== existingInfo.relevantModSeasons.size;
      return isDifferent;
    };

    for (const item of group) {
      let dominated = false;
      for (let idx = keepSet.length - 1; idx >= 0; idx--) {
        if (isStrictlyBetter(keepSet[idx], item)) {
          dominated = true;
          break;
        }
        if (isStrictlyBetter(item, keepSet[idx])) {
          keepSet.splice(idx, 1);
        }
      }
      if (!dominated) {
        keepSet.push(item);
      }
    }

    const groupedByEverything = Map.groupBy(keepSet, ({ dimItem }) => finalGroupingFn(dimItem));
    for (const group of groupedByEverything.values()) {
      group.sort(groupComparator(getUserItemTag));
      groups.push({
        canonicalProcessItem: group[0].processItem,
        items: group.map(({ dimItem }) => dimItem),
      });
    }
  }

  return groups;
}