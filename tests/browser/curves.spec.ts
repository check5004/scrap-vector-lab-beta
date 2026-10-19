import {test,expect} from '@playwright/test';
import {readFile} from 'node:fs/promises';
import {sourceReady,openEditor,openDetailsFor} from './legacy-ui';
test('curve editor retains source, edits handles, exports and closes on desktop and touch',async({page,context,baseURL,isMobile})=>{
  const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
  await context.route('**/*',r=>new URL(r.request().url()).origin===new URL(baseURL!).origin?r.continue():r.abort());
  await page.goto('/');await sourceReady(page);await page.locator('#methodB').check();await page.locator('#analyze').click();await expect(page.locator('#exportJson')).toBeEnabled({timeout:150000});await openEditor(page);await page.locator('#editCurves').click();
  const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible();await expect(dialog.locator('svg image')).toHaveCount(1);
  await dialog.locator('[data-anchor]').selectOption('0,1');await dialog.locator('[data-action="curve"]').click();await expect(dialog.locator('[data-kind="outgoing"]')).toHaveCount(1);

  const before=await dialog.locator('svg path').last().getAttribute('d');
  const handle=dialog.locator('[data-kind="outgoing"]'),box=await handle.boundingBox();if(!box)throw Error('No handle');
  const x=box.x+box.width/2,y=box.y+box.height/2;
  if(isMobile){const session=await context.newCDPSession(page);await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+8,y:y-8}]});await session.send('Input.dispatchTouchEvent',{type:'touchCancel',touchPoints:[]});}
  else {await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+8,y-8);await dialog.locator('svg').dispatchEvent('pointercancel',{pointerId:1});await page.mouse.up();}
  await expect(dialog.locator('svg path').last()).toHaveAttribute('d',before!);
  if(isMobile){const session=await context.newCDPSession(page);await session.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x,y}]});await session.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:x+12,y:y-18}]});await session.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});}
  else {await page.mouse.move(x,y);await page.mouse.down();await page.mouse.move(x+12,y-18);await page.mouse.up();}
  await expect(dialog.locator('svg path').last()).not.toHaveAttribute('d',before!);
  await page.screenshot({path:`test-results/curve-editor-${isMobile?'mobile':'desktop'}.png`,fullPage:false});
  await dialog.locator('[data-action="undo"]').click();await expect(dialog.locator('svg path').last()).toHaveAttribute('d',before!);
  const download=page.waitForEvent('download');await dialog.locator('[data-action="json"]').click();const file=await download,path=await file.path();const json=JSON.parse(await readFile(path!,'utf8'));expect(json.schema_version).toBe('2.0-beta');expect(json.geometry.outer[1].outgoing).toBeTruthy();
  await dialog.locator('[data-action="close"]').click();await page.locator('#editCurves').click();await expect(dialog.locator('[data-kind="outgoing"]')).toHaveCount(1);
  await dialog.locator('.curve-advanced summary').click();page.once('dialog',d=>d.dismiss());await dialog.locator('[data-action="reset"]').click();await expect(dialog.locator('[data-kind="outgoing"]')).toHaveCount(1);
  page.once('dialog',d=>d.accept());await dialog.locator('[data-action="reset"]').click();await expect(dialog.locator('[data-kind="outgoing"]')).toHaveCount(0);
  await dialog.locator('[data-action="undo"]').click();await expect(dialog.locator('[data-kind="outgoing"]')).toHaveCount(1);
  await dialog.locator('[data-action="undo"]').click();await expect(dialog.locator('[data-kind="outgoing"]')).toHaveCount(0);
  await dialog.locator('[data-action="close"]').click();await expect(dialog).toHaveCount(0);await expect(page.locator('#exportJson')).toBeEnabled();await page.locator('#editCurves').click();await expect(page.getByRole('dialog').locator('[data-kind="outgoing"]')).toHaveCount(0);await page.keyboard.press('Escape');await expect(page.getByRole('dialog')).toHaveCount(0);
  // Known-edge scaling must move the photo and curve into the same mm frame once.
  await openDetailsFor(page,'#applyCalibration');
  const a=json.geometry.outer[0],b=json.geometry.outer[1],length=Math.hypot(b.x-a.x,b.y-a.y);
  await page.locator('#calibrationEdge').selectOption('0');await page.locator('#calibrationLength').fill(String(length*1.5));await page.locator('#calibrationAssumptions').check();await page.locator('#applyCalibration').click();await page.locator('#editCurves').click();
  const calibrated=page.getByRole('dialog'),photo=calibrated.locator('svg image');await expect(calibrated.locator('[data-kind="outgoing"]')).toHaveCount(0);
  await expect(photo).toHaveAttribute('width',String(json.board_size_mm.width*1.5));await expect(photo).toHaveAttribute('x',String(a.x*(1-1.5)));
  await calibrated.locator('[data-x]').fill('');await calibrated.locator('[data-action="coordinate"]').click();await expect(calibrated.locator('[data-status]')).toContainText('両方');
  await calibrated.locator('[data-action="close"]').click();expect(errors).toEqual([]);

});
