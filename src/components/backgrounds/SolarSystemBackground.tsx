/**
 * SolarSystemBackground — 太阳系主题画布背景
 */
import { useEffect, useRef, useState } from 'react';
import '../../styles/backgrounds.css';

// 行星图片静态导入（Vite 构建时解析）
import mercuryImg from '../../assets/images/bg/1_mercury.png';
import venusImg from '../../assets/images/bg/2_venus.png';
import earthImg from '../../assets/images/bg/3_earth.png';
import marsImg from '../../assets/images/bg/4_mars.png';
import jupiterImg from '../../assets/images/bg/5_jupiter.png';
import saturnImg from '../../assets/images/bg/6_saturn.png';
import uranusImg from '../../assets/images/bg/7_uranus.png';
import neptuneImg from '../../assets/images/bg/8_neptune.png';

const PLANET_IMAGES: Record<string, string> = {
  mercury: mercuryImg,
  venus: venusImg,
  earth: earthImg,
  mars: marsImg,
  jupiter: jupiterImg,
  saturn: saturnImg,
  uranus: uranusImg,
  neptune: neptuneImg,
};

const PLANET_IDS = Object.keys(PLANET_IMAGES);

export default function SolarSystemBackground() {
  const [activeIndex, setActiveIndex] = useState(0);
  const [visible, setVisible] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);


  // 自动轮播行星（每 80 秒切换）
  useEffect(() => {
    setVisible(true);
    intervalRef.current = setInterval(() => {
      setActiveIndex((prev) => (prev + 1) % PLANET_IDS.length);
    }, 80000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, []);

  return (
    <div className={`solar-bg ${visible ? 'solar-bg--visible' : ''}`}>
      {/* 星场背景 */}
      <div className="solar-stars" />

      {/* 行星图片 */}
      <div className="solar-planet-images">
        {PLANET_IDS.map((id, i) => (
          <figure
            key={id}
            className={`solar-planet-figure ${i === activeIndex ? 'solar-planet-figure--active' : ''}`}
          >
            <img
              src={PLANET_IMAGES[id]}
              alt={id}
            />
          </figure>
        ))}
      </div>
    </div>
  );
}
