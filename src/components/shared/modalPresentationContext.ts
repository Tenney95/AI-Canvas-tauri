import { createContext } from 'react';

/** 隐藏的整页工作区暂不呈现后代模态框，保留业务组件与草稿。 */
export const ModalPresentationContext = createContext(true);
