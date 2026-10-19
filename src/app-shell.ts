/** The beta's single photo → method → analysis → result surface. */
export function createAppShell(
  base: string,
  APP_VERSION: string,
  APP_BUILD: { readonly source_commit: string },
  tuningPanelHtml: string,
): string {
  // The one shared limit lives beside the optional review switch. Keep the
  // diagnostic UI's other IDs intact for the existing tuning controller.
  const diagnostics = tuningPanelHtml.replace(
    /<label class="field">API呼出し上限<select id="reviewMaxCalls">[\s\S]*?<\/select><\/label>/,
    '<p class="hint">API呼出し上限は、解析方法の「Bの追加チェック」で設定できます。</p>',
  );
  const sourceCommit = APP_BUILD.source_commit === 'local'
    ? 'beta/curves-20261019'
    : APP_BUILD.source_commit;

  return `<div class="unified-app">
  <div id="progress" class="progressbar hidden" aria-hidden="true"></div>
  <header class="lab-header">
    <a class="lab-brand" href="${base}" aria-label="端材ラボ ホーム">
      <span class="lab-mark" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M6 5h20v9H16v13H6Z"/><path d="M3 2h5M2 2v5M24 2h6v5M2 24v6h5M25 25h5v5h-5"/></svg></span>
      <span><strong>端材ラボ</strong><small>SCRAP VECTOR LAB</small></span>
    </a>
    <div class="lab-release"><span class="lab-beta">BETA</span><a href="https://check5004.github.io/scrap-vector-lab/" target="_blank" rel="noopener">通常版 ↗</a></div>
  </header>

  <main class="lab-workflow">
    <section class="lab-intro" aria-labelledby="appTitle">
      <p class="lab-kicker">A NEW LIFE FOR EVERY PIECE</p>
      <h1 id="appTitle">端材のかたちを、寸法に。</h1>
      <p>写真を選んで、解析する。輪郭と寸法が、ひとつの画面でつながります。</p>
      <ol class="workflow-path" aria-label="作業の流れ"><li><span>01</span>写真を選ぶ</li><li><span>02</span>解析する</li><li><span>03</span>確認・書き出し</li></ol>
    </section>

    <section class="workflow-card input-card" aria-labelledby="inputHeading">
      <div class="step-heading"><span class="step-number">01</span><div><h2 id="inputHeading">写真を選ぶ</h2><p>ID 0〜3のマーカーと端材を、同じ平面に。</p></div></div>
      <div class="input-row">
        <div class="source-preview-wrap"><canvas id="sourcePreview" class="source-preview" width="180" height="120" aria-label="選択した写真のプレビュー"></canvas><span class="preview-tag">SOURCE</span></div>
        <div class="input-actions">
          <p id="inputSummary" class="input-summary" role="status">写真を選ぶか、サンプルで試してください。</p>
          <div class="input-buttons"><button id="upload" type="button" aria-controls="file"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 13V3m-4 4 4-4 4 4M3 12v5h14v-5"/></svg>写真を選ぶ</button><button id="camera" type="button" aria-controls="cameraFile"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M3 6h3l1-2h6l1 2h3v11H3Z"/><circle cx="10" cy="11" r="3"/></svg>カメラで撮影</button></div>
          <input id="file" type="file" accept="image/*" aria-label="写真ライブラリ・ファイルから選ぶ" class="hidden">
          <input id="cameraFile" type="file" accept="image/*" capture="environment" aria-label="カメラで撮影" class="hidden">
          <p class="hint">初期設定は A4・250 × 170 mm。台紙や大きさは下で変更できます。</p>
        </div>
      </div>
      <div class="input-extras">
        <details class="compact-details sample-details"><summary>サンプルで試す</summary>
          <p class="sample-label">鋼材の質感を持つ合成写真</p>
          <div class="samples"><button type="button" class="sample ai-sample" data-sample="ai-l-shape">L字型</button><button type="button" class="sample ai-sample" data-sample="ai-notched">凹型</button><button type="button" class="sample ai-sample" data-sample="ai-trapezoid-hole">台形＋穴</button></div>
          <p class="hint">AI生成の質感を既知の形状・台紙に合成した検証画像です。実物の写真ではありません。</p>
          <details class="legacy-samples"><summary>従来の比較用サンプル</summary><div class="samples"><button type="button" class="sample" data-sample="l-shape">L字型</button><button type="button" class="sample" data-sample="notched">凹型</button><button type="button" class="sample" data-sample="trapezoid-hole">台形＋穴</button></div></details>
        </details>
        <details id="advancedSettings" class="compact-details calibration-details"><summary>台紙・基準スケール</summary>
          <div class="calibration-fields"><label class="field">規定の内側角の間隔<select id="preset"><option value="a4">A4用紙 · 250 × 170 mm</option><option value="medium">中型台 · 500 × 500 mm</option><option value="large">大型台 · 1000 × 1000 mm</option><option value="custom">カスタム寸法</option></select></label><div id="custom" class="row hidden"><label class="field">横 mm<input id="width" type="number" value="2000" min="10" max="10000"></label><label class="field">縦 mm<input id="height" type="number" value="1000" min="10" max="10000"></label></div></div>
          <p id="scale" class="hint">2500 × 1700 px · 0.100 mm/px</p>
          <div class="print-links"><a href="${base}print/a4-marker-sheet.svg" download>A4台紙 SVG ↗</a><a href="${base}print/a4-marker-sheet.png" download>PNG ↗</a><button id="print" type="button">台紙を印刷</button></div>
          <p class="hint">A4横・100% / 実際のサイズで印刷。100 mmの目盛りを定規で実測してください。切り離したマーカーも台紙と同じ向きに配置します。</p>
        </details>
      </div>
    </section>

    <section class="workflow-card analysis-card" aria-labelledby="analysisHeading">
      <div class="analysis-setup">
        <div class="step-heading"><span class="step-number">02</span><div><h2 id="analysisHeading">解析方法を選ぶ</h2><p>同じ写真から、異なる方法で輪郭を取り出します。</p></div></div>
        <fieldset id="analysisMethod" class="method-picker"><legend class="visually-hidden">解析方法</legend>
          <label class="method-card" for="methodA"><input id="methodA" type="radio" name="analysisMethod" value="A"><span class="method-content"><span class="method-title">クラウドAI（A）</span><span class="method-description">写真から、外周と穴の頂点を直接推論。</span><span class="method-tech">GPT-6 Luna <span>外部API・有料</span></span></span></label>
          <label class="method-card" for="methodB"><input id="methodB" type="radio" name="analysisMethod" value="B" checked><span class="method-content"><span class="method-title">この端末のAI（B）</span><span class="method-description">画像の前景マスクを作り、輪郭を抽出。</span><span class="method-tech">U²-NetP <span>端末内・API費用なし</span></span></span></label>
        </fieldset>
        <div id="autoReviewSettings" class="review-option">
          <label class="review-toggle" for="autoReview"><input id="autoReview" type="checkbox"><span><strong>Bの追加チェック</strong><span>候補画像をクラウドAIで確認・再調整（任意・有料）</span></span></label>
          <label class="review-limit" for="reviewMaxCalls">API呼出し上限<select id="reviewMaxCalls"><option value="1">1回</option><option value="2" selected>2回</option><option value="3">3回</option></select></label>
        </div>
        <details id="analysisSettings" class="analysis-settings"><summary><span>解析の詳細設定</span><span class="details-caption">前景閾値 / 直線化 / 自動調整</span></summary>
          <div class="analysis-settings-content"><section class="manual-analysis-settings"><h3>B · 輪郭の手動調整</h3><p class="hint">通常は変更せずに「解析する」で進めます。Bの結果がある場合、閾値・εの変更でその輪郭を再計算します。</p><div class="mask-settings"><label class="field">直線化の許容差 ε <b id="epsilonValue">1.0 mm</b><input id="epsilon" type="range" min="0.5" max="10" step="0.001" value="1"></label><label class="field">前景確率 <b id="thresholdValue">0.50</b><input id="threshold" type="range" min="0.1" max="0.9" step="0.001" value="0.5"></label></div><p class="hint">Bは320 × 320のAIマスクをミリ座標へ変換します。穴や細部を見落とすことがあります。検出されなかった穴はCモードで修正できます。</p></section>
          <details class="analysis-grid-settings"><summary>A · 画像に重ねる方眼</summary><label class="field grid-field">画像の方眼間隔<select id="gridstep"><option value="10">10 mm</option><option value="25">25 mm</option><option value="50">50 mm</option><option value="100">100 mm</option></select></label><p class="hint">クラウドAIに渡す補正画像の方眼です。台紙の校正値や実寸は変わりません。</p></details>
          ${diagnostics}
          </div>
        </details>
        <div class="analysis-start">
          <div class="analysis-action-row"><button id="analyze" type="button" class="primary analyze-button">解析する <span aria-hidden="true">↗</span></button><button id="analysisCancel" type="button" class="analysis-cancel" hidden>解析を中止</button><div class="key-action"><span id="analysisKeyStatus" role="status">BはAPIキーなしで使えます。</span><button id="configureKey" type="button" class="text-button" aria-controls="apiSettings">接続先・APIキー</button></div></div>
          <p id="analysisProgress" class="analysis-live-progress" role="status" hidden></p>
          <p id="analysisDisclosure" class="analysis-disclosure" aria-live="polite">写真はこの端末内で処理します。外部APIへの送信・API料金は発生しません。</p>
        </div>
        <details id="apiSettings" class="api-settings"><summary>接続先・APIキーの設定</summary>
          <div class="api-fields"><label class="field">API接続先<select id="provider"><option value="openrouter" selected>OpenRouter（OpenRouterのキー）</option><option value="openai">OpenAI直接（OpenAIのキー）</option></select></label><label class="field"><span id="apiKeyLabel">OpenRouter APIキー（このブラウザに保存）</span><input id="apiKey" type="password" placeholder="sk-or-v1-…" autocomplete="off" spellcheck="false" aria-describedby="keyStorageHelp keyStorageStatus"></label></div>
          <p id="providerTarget" class="provider-target"></p><p id="keyStorageStatus" class="provider-note" role="status" aria-live="polite"></p><p id="keyValidation" class="provider-note" role="status"></p>
          <div class="key-settings-actions"><button id="clearKey" type="button">この接続先の保存キーを削除</button></div>
          <details class="key-help"><summary>保存と送信について</summary><p id="keyStorageHelp" class="hint">ベータ専用の保存名を使い、本番の保存キーは読込・移行・削除しません。同じホスト名のため完全なセキュリティ隔離ではありません。入力したキーは接続先ごとに、この端末・ブラウザのlocalStorageへ自動保存され、リロード後も復元されます。共有端末では使わず、利用後は削除してください。暗号化保存ではなく、同じサイト（ホスト名）のページや拡張機能から読まれる可能性があります。別の端末・ブラウザには同期しません。プライベートモードやサイトデータ削除では失われる場合があります。保存だけではAPIに送信しません。</p><p class="hint">ブラウザでのキー入力は信頼する端末・このPoC限定でご利用ください。キーなしでは外部APIを実行しません。接続先ごとのキーが必要です。失敗時の代替推論・架空結果はありません。</p></details>
          <button id="closeKeySettings" type="button" class="close-key-settings">設定を閉じて解析に戻る ↑</button>
        </details>
        <div id="analysisFailure" class="analysis-failure" hidden role="alert"><div><strong>解析を完了できませんでした</strong><p id="analysisFailureMessage">写真や設定を確認して、もう一度お試しください。</p></div><div class="recovery-actions"><button id="retryAnalysis" type="button">もう一度解析</button><button id="failureSettings" type="button">設定を確認</button></div></div>
      </div>
      <section id="journey-root" aria-label="写真から寸法までの連続表示"></section>
    </section>

    <div id="status" role="status" aria-live="polite" class="status workflow-status">写真を選んでください。</div>

    <section class="workflow-card result-card" aria-labelledby="resultHeading">
      <div class="result-top"><div class="step-heading"><span class="step-number">03</span><div><h2 id="resultHeading">寸法を確認する</h2><p id="analysisSummary" role="status">解析結果がここに表示されます。</p></div></div><div class="tabs" aria-label="表示する計測結果"><button type="button" data-mode="A">A · クラウド</button><button type="button" data-mode="B" class="active">B · 端末内</button><button type="button" data-mode="C">C · 編集</button></div></div>
      <div class="result-metrics"><div class="area-metric"><span>正味面積 <small>外周 − 穴</small></span><div class="summaryvalue"><span id="area">—</span><small>mm²</small></div></div><div class="submetric"><span>外周の頂点</span><b id="vertices">—</b></div><div class="submetric"><span>検出した穴</span><b id="holes">—</b></div><div class="submetric"><span>外周長</span><b id="perimeter">— mm</b></div></div>
      <button id="restoreAnalysis" type="button" class="restore-analysis" hidden>前回の解析結果に戻す</button>
      <div id="warnings" class="result-warnings"></div>
      <div class="result-detail-grid"><section class="result-edges"><h3>各辺の寸法 <span>LENGTH / ANGLE</span></h3><div id="edges" class="edge-list"><p class="hint">解析後に各辺の長さと角度を表示します。</p></div></section><section class="result-export"><h3>実寸で書き出す <span>1:1 · MM</span></h3><div class="export-buttons"><button id="exportSvg" type="button" disabled>SVG ↗</button><button id="exportDxf" type="button" disabled>DXF ↗</button><button id="exportJson" type="button" disabled>JSON ↗</button></div><p id="exportStatus" class="hint export-notice" role="status" aria-live="polite"></p><p class="hint">選択中の結果を出力します。SVGはmm単位・寸法レイヤー付き。DXFはmm単位の閉じた輪郭です。</p></section></div>

      <details id="measurementCalibration" class="measurement-calibration"><summary>既知の上面寸法で補正する <span>任意</span></summary><p class="hint">実測した上面の一辺を基準に、計測値と書き出し寸法を補正します。写真や方眼の大きさは変えません。</p><div class="measurement-calibration-fields"><label class="field">基準にする上面の辺<select id="calibrationEdge"><option value="">解析後に辺を選択</option></select></label><label class="field">実測した長さ（mm）<input id="calibrationLength" type="number" min="0.01" step="any" inputmode="decimal" placeholder="例: 120"></label></div><label class="confirm calibration-assumptions"><input id="calibrationAssumptions" type="checkbox"><span>台紙と平行な平板で、レンズ歪みが小さく、選んだ輪郭が実際に上面の輪郭であることを確認しました。</span></label><div class="calibration-actions"><button id="applyCalibration" type="button" disabled>実測値で補正</button><button id="clearCalibration" type="button" disabled>補正を解除</button></div><p id="calibrationStatus" class="hint" role="status">実測値による補正は未適用です。</p><p class="calibration-caution">側面を輪郭として拾った誤りは、この補正では直りません。実物での計測精度は未検証です。重要な寸法は必ず実測してください。</p></details>
      <div class="editor-panel"><div class="editor-disclosure"><div><b>輪郭を編集・比較</b><span>頂点や穴を確認して、必要な部分を手直し。</span></div><button id="toggleEditor" type="button" aria-expanded="false" aria-controls="editorSurface">計測キャンバスを開く</button></div>
        <div id="editorSurface" class="hidden"><div class="canvashead"><div class="legend"><b>MEASUREMENT CANVAS</b><label><input type="checkbox" id="showA" checked><i class="dot a"></i>A</label><label><input type="checkbox" id="showB" checked><i class="dot b"></i>B</label><label><input type="checkbox" id="showC" checked><i class="dot c"></i>C</label></div><select id="view" aria-label="背景表示"><option value="rectified">補正後</option><option value="photo">撮影画像</option><option value="mask">AIマスク</option><option value="grid">方眼</option></select></div><div class="canvaswrap"><svg id="editor" viewBox="0 0 250 170" role="img" aria-label="端材の輪郭と編集可能な頂点"></svg></div><div class="canvasfooter"><span id="sourceLabel">SOURCE / 写真を選んでください</span><span id="markerLabel">MARKERS —</span></div>
          <div class="editbar"><button id="editCurves" type="button" disabled>曲線・頂点編集 β</button><button id="editC" type="button" disabled>Cへコピーして編集</button><button id="undo" type="button" disabled>↶ 戻す</button><button id="delete" type="button" disabled>頂点を削除</button><button id="snap" type="button" disabled>直角に整列 ±5°</button><button id="drawHole" type="button" disabled>＋ 穴を描く</button><button id="drawOuter" type="button">外周を手描き</button><button id="finishDraw" type="button" class="hidden">図形を確定</button><button id="cancelDraw" type="button" class="hidden">描画を中止</button><span id="selected" class="selectednum"></span></div><p class="hint editing-hint">Cモードではピンをドラッグ、辺をタップして頂点を追加できます。ピンを選んで削除、またはダブルタップ。輪郭が交差する編集は確定できません。</p>
        </div>
      </div>
    </section>

    <details id="advancedDiagnostics" class="advanced-diagnostics"><summary><span>処理の診断・検証</span><span class="details-caption">個別実行 / 処理記録 / 検証</span></summary>
      <div class="diagnostics-content"><section class="diagnostic-controls"><h3>処理を個別に実行</h3><p class="hint">通常は「解析する」だけで完了します。ここでは補正・推論・候補調整を個別に確認できます。</p><label class="confirm"><input id="consent" type="checkbox"><span id="consentText"></span></label><div class="diagnostic-buttons"><button id="rectify" type="button">マーカー検出・平面補正</button><button id="runA" type="button" disabled>A · GPT-6 Lunaで推論</button><button id="runB" type="button" disabled>B · 端末内AIで輪郭を抽出</button></div></section>
        <details class="diagnostic-details"><summary>マーカー認識・処理途中の画像</summary><section id="debugPanel" class="panel debug-panel"></section></details>
        <details class="diagnostic-details"><summary>合成写真の検証ベンチ</summary><div class="compare"><h3>既知寸法との比較</h3><div id="benchmark" class="benchgrid"></div><p class="hint">正解は評価だけに使用し、AIの入力・予測には使用しません。曲線は多角形近似。誤差はこの合成画像での結果で、実物の精度保証ではありません。</p></div></details>
      </div>
    </details>
  </main>

  <footer class="lab-footer"><div><p>計測値は目安です。マーカーと測定面を同じ平面にし、重要な寸法は必ず実測してください。</p><details><summary>精度と撮影の注意</summary><p>検証用ツールです。0.1 mm/pxは画像の刻み幅であり、計測精度ではありません。厚み・反り・カメラのレンズ歪み・斜め撮影・印刷倍率で誤差が生じます。AIは穴や細部を見落とすことがあります。マーカーはDICT_4X4_50、0: 左上・1: 右上・2: 右下・3: 左下です。</p></details></div><div class="footer-meta"><span>BETA · <span id="appVersion">${APP_VERSION}</span></span><a href="https://github.com/check5004/scrap-vector-lab/tree/${sourceCommit}" target="_blank" rel="noopener">ソース・検証手順 ↗</a></div></footer>
</div>`;
}
