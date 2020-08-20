import React, { useRef } from 'react';
import { useSelector } from 'react-redux';
import { DimItem } from './item-types';
import DraggableInventoryItem from './DraggableInventoryItem';
import ItemPopupTrigger from './ItemPopupTrigger';
import { CompareService } from '../compare/compare.service';
import { moveItemTo } from './move-item';
import ConnectedInventoryItem from './ConnectedInventoryItem';
import { loadoutDialogOpen } from 'app/loadout/LoadoutDrawer';
import { isPhonePortraitSelector } from 'app/inventory/selectors';
import { showMobileInspect } from 'app/mobile-inspect/mobile-inspect';
import { showDragGhost } from 'app/mobile-inspect/drag-ghost';
import { getCurrentStore } from './stores-helpers';

interface Props {
  item: DimItem;
}

const LONGPRESS_TIMEOUT = 200;

/**
 * The "full" inventory item, which can be dragged around and which pops up a move popup when clicked.
 */
export default function StoreInventoryItem({ item }: Props) {
  const isPhonePortrait = useSelector(isPhonePortraitSelector);
  const longPressed = useRef<boolean>(false);
  const timer = useRef<number>(0);

  const resetInspect = () => {
    showMobileInspect(undefined);
    showDragGhost(undefined);
    window.clearTimeout(timer.current);
    longPressed.current = false;
  };

  const onTouch = (e: React.TouchEvent) => {
    if (loadoutDialogOpen || CompareService.dialogOpen) {
      return;
    }

    // It a longpress happend and the touch move event files, do nothing.
    if (longPressed.current && e.type === 'touchmove') {
      if (!isPhonePortrait) {
        showDragGhost({
          item,
          transform: `translate(${e.touches[0].clientX}px, ${e.touches[0].clientY}px)`,
        });
      }
      return;
    }

    // Always reset the inspect before any other event fires.
    // Useful because if the start event happens twice before another type (it happens.)
    resetInspect();

    if (e.type !== 'touchstart') {
      // Abort longpress timer if touch moved, ended, or cancelled.
      return;
    }

    // Start a timer for the longpress action
    timer.current = window.setTimeout(() => {
      longPressed.current = true;
      if (isPhonePortrait) {
        showMobileInspect(item);
      }
    }, LONGPRESS_TIMEOUT);
  };

  const doubleClicked = (e: React.MouseEvent) => {
    if (!loadoutDialogOpen && !CompareService.dialogOpen) {
      e.stopPropagation();
      const active = getCurrentStore(item.getStoresService().getStores())!;

      // Equip if it's not equipped or it's on another character
      const equip = !item.equipped || item.owner !== active.id;

      moveItemTo(item, active, item.canBeEquippedBy(active) ? equip : false, item.amount);
    }
  };

  let onTouchHandler;
  if ($featureFlags.mobileInspect) {
    onTouchHandler = onTouch;
  }

  return (
    <DraggableInventoryItem item={item} isPhonePortrait={isPhonePortrait}>
      <ItemPopupTrigger item={item}>
        {(ref, onClick) => (
          <ConnectedInventoryItem
            item={item}
            allowFilter={true}
            innerRef={ref}
            onClick={onClick}
            onDoubleClick={doubleClicked}
            onTouch={onTouchHandler}
          />
        )}
      </ItemPopupTrigger>
    </DraggableInventoryItem>
  );
}
