import type { ComponentChildren, CSSProperties } from 'preact';
import { Icon } from './Icon';

interface ButtonProps {
    icon?: string;
    secondary?: boolean;
    disabled?: boolean;
    onClick?: (e: Event) => void;
    style?: CSSProperties;
    children?: ComponentChildren;
}

export function Button({ icon, secondary, children, ...rest }: ButtonProps) {
    return <button {...rest} class={secondary ? 'cs-button secondary' : 'cs-button'}>{icon && <Icon name={icon} />}{children}</button>;
}
