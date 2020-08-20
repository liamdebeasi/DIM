import React, { useState } from 'react';
import { useSubscription } from 'app/utils/hooks';
import InventoryItem from 'app/inventory/InventoryItem';
import { showDragGhost$, DragGhostProps } from './drag-ghost';

import styles from './DragGhost.m.scss';

/**
 * This is used to show a dragged item for touch events
 */
export default function DragGhost() {
  const [state, setState] = useState<DragGhostProps | undefined>();

  useSubscription(() => showDragGhost$.subscribe((props) => setState(props)));

  if (!state?.item) {
    return null;
  }

  return (
    <div className={styles.ghostImg} style={{ transform: state.transform }}>
      <InventoryItem item={state.item} />
    </div>
  );
}
