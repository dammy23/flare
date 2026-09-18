import type { ButtonHTMLAttributes } from 'react'

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'default' | 'primary' | 'danger'
}

export function Button({ variant = 'default', className, ...rest }: ButtonProps) {
  const variantClass = variant === 'default' ? '' : ` flare-button--${variant}`
  return <button className={`flare-button${variantClass}${className ? ` ${className}` : ''}`} {...rest} />
}
