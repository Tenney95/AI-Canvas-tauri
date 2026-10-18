/** 手动确认 4927 后播放的天台致敬；纯矢量动画，不请求网络或控制 MCP 会话。 */
import { useEffect, useId } from 'react';
import { useReducedMotion } from 'framer-motion';
import ModalOverlay from '../shared/ModalOverlay';
import PopupCloseButton from '../shared/PopupCloseButton';
import { useT } from '../../i18n';

export default function McpRooftopTribute({ isOpen, onClose }: { isOpen: boolean; onClose: () => void }) {
  const t = useT();
  const skyId = useId();
  const reducedMotion = useReducedMotion();

  useEffect(() => {
    // 减少动态效果时保留静态画面与对白，由用户自行关闭。
    if (!isOpen || reducedMotion) return;
    const timer = window.setTimeout(onClose, 8200);
    return () => window.clearTimeout(timer);
  }, [isOpen, onClose, reducedMotion]);

  return (
    <ModalOverlay isOpen={isOpen} onClose={onClose} ariaLabel={t('天台彩蛋')}
      className="mcp-rooftop-tribute" motionPreset="quick" backdropBlur={false} zIndex={300}>
      <div className="flex items-center justify-between gap-2 border-b border-canvas-border p-3">
        <div className="flex items-center gap-3">
          <span className="mcp-rooftop-code">4927</span>
          <span className="text-xs text-canvas-text-secondary">{t('天台见')}</span>
        </div>
        <PopupCloseButton ariaLabel={t('关闭')} onClick={onClose} />
      </div>

      <div className="mcp-rooftop-stage" aria-hidden="true">
        <svg viewBox="0 0 960 540" className="mcp-rooftop-scene" focusable="false">
          <defs>
            <linearGradient id={skyId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0" className="mcp-rooftop-sky-top" />
              <stop offset="1" className="mcp-rooftop-sky-bottom" />
            </linearGradient>
          </defs>
          <rect width="960" height="540" fill={`url(#${skyId})`} />
          <g className="mcp-rooftop-clouds">
            <path d="M-100 92Q70 43 212 80T510 65T1000 90V125H-100Z" />
            <path d="M-40 158Q120 130 305 152T680 134T1060 158V174H-40Z" />
          </g>
          <path className="mcp-rooftop-mountains" d="M0 236 63 204 116 216 188 162 243 191 298 149 350 177 418 161 477 196 550 173 619 200 690 162 764 198 835 173 900 193 960 169V330H0Z" />
          <g className="mcp-rooftop-city">
            <path d="M0 297V248H25V200H46V279H62V222H95V267H111V179H138V264H153V212H185V280H204V241H229V204H245V281H260V233H284V272H304V190H322V281H343V227H365V272H380V211H397V281H416V244H443V201H469V278H482V238H508V261H529V198H547V278H566V229H598V268H618V212H645V277H665V231H694V188H711V271H731V243H754V216H778V280H801V230H825V268H845V202H866V276H882V237H914V276H934V220H960V315H0Z" />
            <path className="mcp-rooftop-city-detail" d="M120 185V264M313 195V281M452 207V278M538 203V278M702 194V271M855 207V276M0 291H960" />
          </g>
          <path className="mcp-rooftop-water" d="M0 302H960V383H0Z" />
          <g className="mcp-rooftop-waterlines">
            <path d="M20 324H162M210 341H374M544 324H686M748 348H917M405 314H485" />
          </g>
          <path className="mcp-rooftop-deck" d="M0 348 960 369V540H0Z" />
          <g className="mcp-rooftop-tiles">
            <path d="M0 386 960 412M0 446 960 489M0 517 424 540M90 350 0 540M280 354 192 540M470 358 447 540M660 362 723 540M850 366 960 540" />
          </g>
          <path className="mcp-rooftop-parapet" d="M0 315 960 342V368L0 343Z" />
          <path className="mcp-rooftop-railing" d="M0 313 960 340M0 341 960 366" />

          <g className="mcp-rooftop-person mcp-rooftop-person-left">
            <path d="M290 260 283 286 313 301 325 267Z" />
            <path d="M273 214Q278 182 306 184 334 185 336 214L333 234 343 244 333 249 329 269Q314 281 292 265L280 244Z" />
            <path className="mcp-rooftop-hair" d="M273 225Q259 196 281 182 305 167 332 184L343 202 316 199 300 207 291 235 281 229Z" />
            <path d="M281 283 251 299 231 343 219 436 246 444 260 358 258 456 345 456 337 351 356 417 380 408 352 316 325 283 305 316Z" />
            <path className="mcp-rooftop-shirt" d="M281 282 305 304 326 282 316 360 292 348Z" />
            <path className="mcp-rooftop-lapel" d="M277 285 265 319 287 330 278 343 303 394M328 287 339 318 320 333" />
            <path d="M260 445 256 534 289 534 304 458 320 534 354 534 343 445Z" />
          </g>
          <g className="mcp-rooftop-person mcp-rooftop-person-right">
            <path d="M683 268 677 293 711 311 719 269Z" />
            <path d="M675 214Q700 194 720 219L725 245 714 272Q696 287 678 268L674 250 661 245 672 235Z" />
            <path className="mcp-rooftop-hair" d="M666 219Q668 192 695 190 727 184 738 215L731 248 718 250 710 222 686 215 673 232Z" />
            <path d="M677 289 710 298 730 287 757 308 779 434 753 443 730 347 742 458 655 458 661 340 654 308Z" />
            <path className="mcp-rooftop-lapel" d="M680 289 689 329 707 312 724 331 731 290M697 327 702 441" />
            <path d="M656 447 651 534 687 534 701 467 716 534 750 534 741 447Z" />
            <g className="mcp-rooftop-arm">
              <path d="M680 300 595 266 479 246 472 272 591 308 666 337Z" />
              <path className="mcp-rooftop-hand" d="M484 247 461 239 444 246 444 261 475 275Z" />
              <path d="M380 234H461V245L454 248 457 270H444L435 248H380Z" />
              <path className="mcp-rooftop-lapel" d="M440 249Q431 265 448 264" />
            </g>
          </g>
        </svg>
        <div className="mcp-rooftop-vignette" />
        <div className="mcp-rooftop-captions">
          <p className="mcp-rooftop-line mcp-rooftop-line-first"><span>4927</span>{t('我想做个好人。')}</p>
          <p className="mcp-rooftop-line mcp-rooftop-line-second"><span>27149</span>{t('对不起，我是警察。')}</p>
          <p className="mcp-rooftop-credit"><span>{t('致敬《无间道》')}</span><strong>27149 · 4927</strong></p>
        </div>
      </div>

      <p className="sr-only">{t('致敬《无间道》')} {t('我想做个好人。')} {t('对不起，我是警察。')}</p>
      <div className="flex items-center justify-between gap-2 border-t border-canvas-border p-3">
        <span className="text-xs text-canvas-text-muted">AI Canvas · 27149 / 4927</span>
        <button type="button" className="ui-btn ui-btn--ghost ui-btn--sm" onClick={onClose}>{t('关闭')}</button>
      </div>
    </ModalOverlay>
  );
}
