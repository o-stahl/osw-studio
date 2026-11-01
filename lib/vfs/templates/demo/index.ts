import { ProjectTemplate } from '../../project-templates';
import { HANDLEBARS_DOMAIN_PROMPT } from '@/lib/llm/prompts/handlebars';

export const DEMO_PROJECT_TEMPLATE: ProjectTemplate = {
  name: 'Example Studios',
  description: 'Creative agency portfolio showcasing modern web development capabilities',
  directories: ['/styles', '/scripts', '/portfolio', '/assets', '/assets/images', '/templates'],
  files: [
    {
      path: '/index.html',
      content: `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Example Studios - Creative Agency</title>
    <link rel="icon" type="image/svg+xml" href="/assets/images/favicon.svg">
    <link rel="stylesheet" href="/styles/main.css">
</head>
<body>
    {{> navigation}}

    <main>
        <section class="hero">
            <div class="hero-content">
                <h1>Crafting Digital Experiences</h1>
                <p class="hero-subtitle">We create stunning websites and digital solutions that captivate audiences and drive results</p>
                <div class="hero-buttons">
                    <a href="#services" class="btn btn-primary">Our Services</a>
                    <a href="#work" class="btn btn-secondary">View Work</a>
                </div>
            </div>
        </section>
        
        <div class="container" id="services">
            <div class="section-header">
                <h2>What We Do</h2>
                <p class="section-subtitle">From concept to launch, we deliver exceptional digital experiences</p>
            </div>
        
            <div class="card-grid">
                <div class="card">
                    <div class="service-icon">Design</div>
                    <h3>Web Design</h3>
                    <p>Beautiful, user-centered designs that make lasting impressions</p>
                    <a href="/portfolio.html" class="btn">See Our Work</a>
                </div>
                
                <div class="card">
                    <div class="service-icon">Code</div>
                    <h3>Development</h3>
                    <p>Fast, responsive websites built with modern technologies</p>
                    <a href="/portfolio.html" class="btn">View Projects</a>
                </div>
                
                <div class="card">
                    <div class="service-icon">Mobile</div>
                    <h3>Mobile Apps</h3>
                    <p>Native and web applications that users love to use</p>
                    <a href="/contact.html" class="btn">Get Started</a>
                </div>
            </div>
        </div>

        <section class="featured-work" id="work">
            <h2>Recent Work</h2>
            <div class="work-grid">
                <div class="work-item">
                    <img src="https://picsum.photos/400/300?random=1" alt="Project 1" class="work-image">
                    <div class="work-info">
                        <h3>Brand Identity</h3>
                        <p>Complete visual identity for tech startup</p>
                    </div>
                </div>
                <div class="work-item">
                    <img src="https://picsum.photos/400/300?random=2" alt="Project 2" class="work-image">
                    <div class="work-info">
                        <h3>Portfolio Website</h3>
                        <p>Clean and modern portfolio showcase</p>
                    </div>
                </div>
                <div class="work-item">
                    <img src="https://picsum.photos/400/300?random=3" alt="Project 3" class="work-image">
                    <div class="work-info">
                        <h3>Mobile Application</h3>
                        <p>Social platform connecting local communities</p>
                    </div>
                </div>
            </div>
            
            <div class="featured-work-cta">
                <a href="/portfolio.html" class="btn btn-primary">View Full Portfolio</a>
            </div>
        </section>
        
        <section class="cta-section">
            <div class="cta-content">
                <h2>Ready to Build Something Amazing?</h2>
                <p>Let's turn your ideas into reality. We'd love to hear about your project.</p>
                <a href="/contact.html" class="btn btn-primary">Start Your Project</a>
            </div>
        </section>
        </div>
    </main>

    {{> footer}}

    <script src="/scripts/main.js"></script>
</body>
</html>`
    },
    {
      path: '/portfolio.html',
      content: `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Portfolio - Example Studios</title>
    <link rel="icon" type="image/svg+xml" href="/assets/images/favicon.svg">
    <link rel="stylesheet" href="/styles/main.css">
    <link rel="stylesheet" href="/styles/portfolio.css">
</head>
<body>
    <nav class="navbar">
        <a href="/" class="nav-brand">
            <img src="/assets/images/logo.svg" alt="Example Studios" class="nav-logo">
            <span>Example Studios</span>
        </a>
        
        <button class="nav-toggle" aria-label="Toggle navigation menu" aria-expanded="false">
            <span class="hamburger-line"></span>
            <span class="hamburger-line"></span>
            <span class="hamburger-line"></span>
        </button>
        
        <ul class="nav-menu">
            <li><a href="/" class="nav-link">Home</a></li>
            <li><a href="/portfolio.html" class="nav-link active">Portfolio</a></li>
            <li><a href="/about.html" class="nav-link">About</a></li>
            <li><a href="/contact.html" class="nav-link">Contact</a></li>
        </ul>
    </nav>

    <main>
        <section class="hero sub-page">
            <div class="hero-content">
                <h1>Our Portfolio</h1>
                <p class="hero-subtitle">Explore our recent projects and see how we bring ideas to life</p>
            </div>
        </section>
        
        <div class="container">
            <section class="content-section">
                <div class="section-header">
                    <h2>Our Work</h2>
                    <p class="section-subtitle">Filter by category to explore our diverse portfolio of projects</p>
                </div>
                
                <div class="portfolio-filters">
                    <button class="filter-btn active" data-filter="all">All Projects</button>
                    <button class="filter-btn" data-filter="web">Web Design</button>
                    <button class="filter-btn" data-filter="mobile">Mobile Apps</button>
                    <button class="filter-btn" data-filter="branding">Branding</button>
                </div>
                
                <div class="portfolio-grid">
            <div class="portfolio-item" data-category="web">
                <a href="/portfolio/techflow-dashboard.html">
                    <img src="https://picsum.photos/400/300?random=10" alt="TechFlow Dashboard" class="portfolio-image">
                    <div class="portfolio-overlay">
                        <h3>TechFlow Dashboard</h3>
                        <p>Modern analytics platform with real-time data visualization</p>
                        <div class="portfolio-tags">
                            <span class="tag">React</span>
                            <span class="tag">D3.js</span>
                            <span class="tag">Node.js</span>
                        </div>
                    </div>
                </a>
            </div>
            
            <div class="portfolio-item" data-category="mobile">
                <img src="https://picsum.photos/400/300?random=11" alt="Fitness Tracker App" class="portfolio-image">
                <div class="portfolio-overlay">
                    <h3>Fitness Tracker App</h3>
                    <p>Cross-platform mobile app for health and wellness tracking</p>
                    <div class="portfolio-tags">
                        <span class="tag">React Native</span>
                        <span class="tag">Firebase</span>
                        <span class="tag">Redux</span>
                    </div>
                </div>
            </div>
            
            <div class="portfolio-item" data-category="branding">
                <img src="https://picsum.photos/400/300?random=12" alt="Green Earth Campaign" class="portfolio-image">
                <div class="portfolio-overlay">
                    <h3>Green Earth Campaign</h3>
                    <p>Complete brand identity for environmental awareness initiative</p>
                    <div class="portfolio-tags">
                        <span class="tag">Brand Design</span>
                        <span class="tag">Illustration</span>
                        <span class="tag">Print</span>
                    </div>
                </div>
            </div>
            
            <div class="portfolio-item" data-category="web">
                <img src="https://picsum.photos/400/300?random=13" alt="Web Application" class="portfolio-image">
                <div class="portfolio-overlay">
                    <h3>Web Application</h3>
                    <p>Interactive web application with modern features</p>
                    <div class="portfolio-tags">
                        <span class="tag">React</span>
                        <span class="tag">Node.js</span>
                        <span class="tag">PostgreSQL</span>
                    </div>
                </div>
            </div>
            
            <div class="portfolio-item" data-category="mobile">
                <img src="https://picsum.photos/400/300?random=14" alt="Recipe Sharing App" class="portfolio-image">
                <div class="portfolio-overlay">
                    <h3>Recipe Sharing App</h3>
                    <p>Social platform for food enthusiasts to share and discover recipes</p>
                    <div class="portfolio-tags">
                        <span class="tag">Flutter</span>
                        <span class="tag">AWS</span>
                        <span class="tag">ML Kit</span>
                    </div>
                </div>
            </div>
            
            <div class="portfolio-item" data-category="branding">
                <img src="https://picsum.photos/400/300?random=15" alt="StartupLab Identity" class="portfolio-image">
                <div class="portfolio-overlay">
                    <h3>StartupLab Identity</h3>
                    <p>Modern brand identity for tech incubator and coworking space</p>
                    <div class="portfolio-tags">
                        <span class="tag">Logo Design</span>
                        <span class="tag">Web Design</span>
                        <span class="tag">Marketing</span>
                    </div>
                </div>
            </div>
                </div>
            </section>
        </div>
        
        <section class="cta-section">
            <div class="cta-content">
                <h2>Ready to Build Something Amazing?</h2>
                <p>Let's turn your ideas into reality. We'd love to hear about your project.</p>
                <a href="/contact.html" class="btn btn-primary">Start Your Project</a>
            </div>
        </section>
    </main>

    {{> footer}}

    <script src="/scripts/main.js"></script>
    <script src="/scripts/portfolio.js"></script>
</body>
</html>`
    },
    {
      path: '/about.html',
      content: `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>About - Example Studios</title>
    <link rel="icon" type="image/svg+xml" href="/assets/images/favicon.svg">
    <link rel="stylesheet" href="/styles/main.css">
</head>
<body>
    <nav class="navbar">
        <a href="/" class="nav-brand">
            <img src="/assets/images/logo.svg" alt="Example Studios" class="nav-logo">
            <span>Example Studios</span>
        </a>
        
        <button class="nav-toggle" aria-label="Toggle navigation menu" aria-expanded="false">
            <span class="hamburger-line"></span>
            <span class="hamburger-line"></span>
            <span class="hamburger-line"></span>
        </button>
        
        <ul class="nav-menu">
            <li><a href="/" class="nav-link">Home</a></li>
            <li><a href="/portfolio.html" class="nav-link">Portfolio</a></li>
            <li><a href="/about.html" class="nav-link active">About</a></li>
            <li><a href="/contact.html" class="nav-link">Contact</a></li>
        </ul>
    </nav>

    <main>
        <section class="hero sub-page">
            <div class="hero-content">
                <h1>About Example Studios</h1>
                <p class="hero-subtitle">We're a passionate team of designers and developers crafting exceptional digital experiences that make a difference.</p>
            </div>
        </section>
        
        <div class="container">

        <section class="content-section">
            <div class="section-header">
                <h2>Our Story</h2>
                <p class="section-subtitle">From humble beginnings to digital excellence</p>
            </div>
            <div class="card-grid">
                <div class="card">
                    <div class="service-icon">🚀</div>
                    <h3>Founded in 2020</h3>
                    <p>Example Studios emerged from a simple belief: great design should be accessible to everyone. What started as a small team of passionate creators has grown into a full-service digital agency.</p>
                </div>
                
                <div class="card">
                    <div class="service-icon">💡</div>
                    <h3>Our Philosophy</h3>
                    <p>We believe in the power of collaboration, the importance of user-centered design, and the magic that happens when creativity meets technology.</p>
                </div>
            </div>
        </section>

        <section class="content-section">
            <div class="section-header">
                <h2>Our Mission</h2>
                <p class="section-subtitle">Crafting digital experiences that make a difference</p>
            </div>
            <div class="card">
                <div class="service-icon">🎯</div>
                <h3>Empowering Through Design</h3>
                <p>To empower businesses and individuals with stunning, functional digital solutions that not only look great but drive real results. We're not just building websites and applications; we're crafting digital experiences that connect, engage, and inspire.</p>
                <a href="/contact.html" class="btn">Start Your Project</a>
            </div>
        </section>

        <section class="content-section">
            <div class="section-header">
                <h2>Our Team</h2>
            </div>
            <div class="team-grid">
                <div class="team-member">
                    <img src="https://picsum.photos/200/200?random=1" alt="Sarah Johnson">
                    <h3>Sarah Johnson</h3>
                    <div class="role">Creative Director</div>
                    <p>With over 8 years in design, Sarah leads our creative vision and ensures every project tells a compelling story.</p>
                </div>
                
                <div class="team-member">
                    <img src="https://picsum.photos/200/200?random=2" alt="Mike Chen">
                    <h3>Mike Chen</h3>
                    <div class="role">Lead Developer</div>
                    <p>Mike transforms designs into responsive, performant web experiences using the latest technologies and best practices.</p>
                </div>
                
                <div class="team-member">
                    <img src="https://picsum.photos/200/200?random=3" alt="Emily Rodriguez">
                    <h3>Emily Rodriguez</h3>
                    <div class="role">UX Designer</div>
                    <p>Emily ensures every user interaction is intuitive and delightful, backed by research and user testing.</p>
                </div>
            </div>
        </section>

        <section class="content-section">
            <div class="section-header">
                <h2>Our Values</h2>
            </div>
            <div class="card-grid">
                <div class="card">
                    <div class="service-icon">Creativity</div>
                    <h3>Creativity First</h3>
                    <p>We believe every project deserves a unique, creative approach that stands out in the digital landscape.</p>
                </div>
                
                <div class="card">
                    <div class="service-icon">Performance</div>
                    <h3>Performance Driven</h3>
                    <p>Beautiful designs mean nothing without flawless performance. We optimize for speed, accessibility, and user experience.</p>
                </div>
                
                <div class="card">
                    <div class="service-icon">Partnership</div>
                    <h3>Collaboration</h3>
                    <p>The best results come from working closely with our clients as partners, not just service providers.</p>
                </div>
                
                <div class="card">
                    <div class="service-icon">Innovation</div>
                    <h3>Innovation</h3>
                    <p>We stay ahead of industry trends and constantly explore new technologies to deliver cutting-edge solutions.</p>
                </div>
            </div>
        </section>
        
        <section class="cta-section">
            <div class="cta-content">
                <h2>Ready to Build Something Amazing?</h2>
                <p>Let's turn your ideas into reality. We'd love to hear about your project.</p>
                <a href="/contact.html" class="btn btn-primary">Start Your Project</a>
            </div>
        </section>
        </div>
    </main>

    {{> footer}}

    <script src="/scripts/main.js"></script>
</body>
</html>`
    },
    {
      path: '/styles/main.css',
      content: `/* Main Stylesheet - Shared across all pages */

:root {
  --primary: #ea580c;
  --primary-dark: #c2410c;
  --secondary: #0891b2;
  --secondary-dark: #0e7490;
  --accent: #f59e0b;
  --neutral: #64748b;
  --bg: linear-gradient(180deg, #ffffff 0%, #fdfdfd 100%);
  --bg-secondary: linear-gradient(180deg, #f4f4f4 0%, #f8fafc 100%);
  --text: #1e293b;
  --text-light: #64748b;
  --border: #e2e8f0;
  --radius: 12px;
  --shadow: 0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04);
  
  /* Layout variables */
  --navbar-height: 65px;
  --navbar-bg: rgba(255, 255, 255, 0.95);
  --hero-gradient-blue: rgba(26, 54, 93, 0.9);
  --hero-gradient-orange: rgba(255, 123, 0, 0.8);
  
  /* Responsive Typography Scale (Mobile-first) */
  --text-xs: 0.75rem;
  --text-sm: 0.875rem;
  --text-base: 1rem;
  --text-lg: 1.125rem;
  --text-xl: 1.25rem;
  --text-2xl: 1.5rem;
  --text-3xl: 1.875rem;
  --text-4xl: 2.25rem;
  --text-5xl: 3rem;
  --text-6xl: 3.75rem;
  
  /* Semantic Typography Variables */
  --heading-h1: var(--text-4xl);
  --heading-h2: var(--text-3xl);
  --heading-h3: var(--text-xl);
  --heading-h4: var(--text-lg);
  --heading-h5: var(--text-base);
  --text-subtitle: var(--text-lg);
  --text-body: var(--text-base);
  --text-small: var(--text-sm);
  
  /* Responsive Spacing Scale */
  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 0.75rem;
  --space-4: 1rem;
  --space-5: 1.25rem;
  --space-6: 1.5rem;
  --space-8: 2rem;
  --space-10: 2.5rem;
  --space-12: 3rem;
  --space-16: 4rem;
  --space-20: 5rem;
  
  /* Container and Grid Variables */
  --container-padding: var(--space-4);
  --grid-gap: var(--space-6);
  --card-padding: var(--space-6);
  --section-spacing: var(--space-12);
}

/* Tablet Breakpoint - 768px+ */
@media (min-width: 768px) {
  :root {
    /* Larger typography for tablet */
    --text-3xl: 2.25rem;
    --text-4xl: 2.75rem;
    --text-5xl: 3.5rem;
    --text-6xl: 4.5rem;
    
    /* Updated semantic typography for tablet */
    --heading-h1: var(--text-4xl);
    --heading-h2: var(--text-3xl);
    --heading-h3: var(--text-2xl);
    --heading-h4: var(--text-xl);
    --text-subtitle: var(--text-xl);
    
    /* Increased spacing for tablet */
    --container-padding: var(--space-6);
    --grid-gap: var(--space-8);
    --card-padding: var(--space-8);
    --section-spacing: var(--space-16);
  }
}

/* Desktop Breakpoint - 1024px+ */
@media (min-width: 1024px) {
  :root {
    /* Larger typography for desktop */
    --text-4xl: 2.5rem;
    --text-5xl: 3rem;
    --text-6xl: 3.5rem;
    
    /* Updated semantic typography for desktop */
    --heading-h1: var(--text-4xl);
    --heading-h2: var(--text-3xl);
    --heading-h3: var(--text-2xl);
    --heading-h4: var(--text-xl);
    
    /* Increased spacing for desktop */
    --container-padding: var(--space-8);
    --grid-gap: var(--space-10);
    --card-padding: var(--space-10);
    --section-spacing: var(--space-20);
  }
}

/* Large Desktop Breakpoint - 1200px+ */
@media (min-width: 1200px) {
  :root {
    /* Maximum typography scaling */
    --text-6xl: 4rem;
    
    /* Maximum spacing */
    --section-spacing: var(--space-24, 6rem);
  }
}

* {
  margin: 0;
  padding: 0;
  box-sizing: border-box;
}

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
  background: var(--bg);
  color: var(--text);
  line-height: 1.6;
}

/* Navigation */
.navbar {
  padding: var(--space-4) var(--container-padding);
  display: flex;
  justify-content: space-between;
  align-items: center;
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  z-index: 1000;
  transition: transform 0.3s ease;
  backdrop-filter: opacity(0);
  background: var(--navbar-bg);
  height: var(--navbar-height);
}

.navbar.hidden {
  transform: translateY(-100%);
}

body {
  padding-top: var(--navbar-height);
}

.nav-brand {
  font-size: var(--text-xl);
  font-weight: 600;
  color: var(--text);
  text-decoration: none;
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.nav-logo {
  width: 28px;
  height: 28px;
}

.nav-menu {
  display: flex;
  list-style: none;
  gap: var(--space-6);
}

.nav-link {
  color: var(--text-light);
  text-decoration: none;
  transition: all 0.2s ease;
  border-radius: var(--space-1);
  padding: var(--space-2);
}

.nav-link:hover,
.nav-link.active {
  color: var(--primary);
}

.nav-link:focus {
  outline: none;
}

/* Hamburger Menu Button */
.nav-toggle {
  display: none;
  flex-direction: column;
  justify-content: space-between;
  width: 24px;
  height: 18px;
  background: transparent;
  border: none;
  cursor: pointer;
  padding: 0;
  z-index: 1001;
  border-radius: var(--space-1);
}

.nav-toggle:focus {
  outline: none;
}

.hamburger-line {
  width: 100%;
  height: 2px;
  background: var(--text);
  transition: all 0.3s ease;
  transform-origin: center;
}

.nav-toggle.active .hamburger-line:nth-child(1) {
  transform: rotate(45deg) translate(6px, 6px);
}

.nav-toggle.active .hamburger-line:nth-child(2) {
  opacity: 0;
}

.nav-toggle.active .hamburger-line:nth-child(3) {
  transform: rotate(-45deg) translate(6px, -6px);
}

/* Tablet Responsive - Enhanced desktop experience */
@media (min-width: 768px) and (max-width: 1023px) {
  .nav-menu {
    gap: var(--space-4);
  }
  
  .nav-link {
    font-size: var(--text-sm);
    padding: var(--space-2) var(--space-3);
  }
}

/* Mobile Menu Styles - Hamburger menu only on mobile */
@media (max-width: 767px) {
  .nav-toggle {
    display: flex;
  }
  
  .navbar.menu-open {
    background: rgba(255, 255, 255, 1);
    backdrop-filter: opacity(0);
  }
  
  .nav-menu {
    position: fixed;
    top: var(--navbar-height);
    left: 0;
    right: 0;
    background: #fff;
    backdrop-filter: opacity(0);
    flex-direction: column;
    padding: var(--space-6) var(--space-4) var(--space-8);
    gap: 0;
    transform: translateY(-100%);
    opacity: 0;
    visibility: hidden;
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  }
  
  .nav-menu.active {
    transform: translateY(0);
    opacity: 1;
    visibility: visible;
  }
  
  .nav-link {
    font-size: var(--text-lg);
    font-weight: 500;
    padding: var(--space-2) var(--space-6);
    border-radius: var(--space-2);
    background: transparent;
    border: none;
    transition: all 0.2s ease;
    position: relative;
    width: fit-content;
    display: block;
    margin: 0 auto;
  }
  
  .nav-link:hover {
    background: var(--bg-secondary);
    color: var(--primary);
    transform: translateY(-2px);
  }
  
  .nav-link.active {
    background: var(--primary);
    color: white;
    font-weight: 600;
  }
  
  .nav-link.active::before {
    content: '';
    position: absolute;
    left: 0;
    top: 50%;
    transform: translateY(-50%);
    width: 4px;
    height: 20px;
    background: white;
    border-radius: 2px;
  }
}

/* Container */
.container {
  max-width: 1000px;
  margin: 0 auto;
  padding: var(--card-padding);
}

/* Universal Heading Styles */
h1 {
  font-size: var(--heading-h1);
  margin-bottom: var(--space-4);
  font-weight: 700;
  line-height: 1.2;
}

h2 {
  font-size: var(--heading-h2);
  margin-bottom: var(--space-4);
  font-weight: 600;
  line-height: 1.3;
}

h3 {
  font-size: var(--heading-h3);
  margin-bottom: var(--space-3);
  font-weight: 600;
  line-height: 1.4;
}

h4 {
  font-size: var(--heading-h4);
  margin-bottom: var(--space-2);
  font-weight: 600;
  line-height: 1.4;
}

h5 {
  font-size: var(--heading-h5);
  margin-bottom: var(--space-2);
  font-weight: 600;
  line-height: 1.5;
}

p {
  color: var(--text-light);
  font-size: var(--text-body);
  margin-bottom: var(--space-8);
  line-height: 1.6;
}

/* Cards */
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: var(--space-6);
  margin-bottom: var(--section-spacing);
}

.card {
  background: var(--bg-secondary);
  padding: var(--card-padding);
  border-radius: var(--radius);
  text-align: center;
}

.card h2 {
  font-size: var(--heading-h2);
  margin-bottom: var(--space-4);
}

.card p {
  font-size: var(--text-body);
  margin-bottom: var(--space-6);
}

/* Buttons */
.btn {
  display: inline-block;
  background: var(--primary);
  color: white;
  padding: var(--space-3) var(--space-6);
  border: none;
  border-radius: var(--radius);
  cursor: pointer;
  text-decoration: none;
  font-size: var(--text-body);
  font-weight: 500;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.btn:hover {
  background: var(--primary-dark);
  transform: translateY(-2px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.15);
}

.btn:active {
  transform: translateY(0);
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
}

.btn:focus {
  outline: none;
}

.btn-small {
  padding: var(--space-2) var(--space-4);
  font-size: var(--text-sm);
}

/* Hero Section */
.hero {
  height: calc(100vh - var(--navbar-height) - var(--container-padding));
  background: linear-gradient(135deg, var(--hero-gradient-blue), var(--hero-gradient-orange)),
              url('/assets/images/example-background.jpg') center/cover;
  background-size: contain;
  color: white;
  display: flex;
  align-items: center;
  justify-content: center;
  text-align: center;
  padding: var(--space-8) var(--container-padding);
  position: relative;
  overflow: hidden;
  margin: 0rem var(--container-padding) var(--section-spacing);
  border-radius: var(--radius);
}

.hero.sub-page {
  height: calc(50vh + var(--navbar-height));
  min-height: calc(300px + var(--navbar-height));
}

.hero-content {
  max-width: 800px;
  z-index: 1;
}

.hero h1 {
  font-size: var(--text-4xl);
  margin-bottom: var(--space-4);
  font-weight: 700;
  text-shadow: 2px 2px 4px rgba(0, 0, 0, 0.3);
}

.hero-subtitle {
  font-size: var(--text-subtitle);
  opacity: 0.95;
  margin-bottom: var(--space-8);
  color: white;
}

.hero-buttons {
  display: flex;
  gap: var(--space-4);
  justify-content: center;
  flex-wrap: wrap;
}

.btn-primary {
  background: var(--primary);
  color: white;
}

.btn-primary:hover {
  background: var(--primary-dark);
  transform: translateY(-2px) scale(1.02);
  box-shadow: 0 6px 16px rgba(234, 88, 12, 0.25);
}

.btn-primary:focus {
  outline: none;
}

.btn-secondary {
  background: rgba(255, 255, 255, 0.2);
  color: white;
  backdrop-filter: opacity(0);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.btn-secondary:hover {
  background: rgba(255, 255, 255, 0.3);
  transform: translateY(-2px) scale(1.02);
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.15);
}

.btn-secondary:focus {
  outline: none;
}

/* Features Section */
.features-section {
  padding: var(--section-spacing) 0;
  background: var(--bg-secondary);
  border-radius: var(--radius);
  margin-top: var(--section-spacing);
}

.feature-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: var(--space-6);
  margin-top: var(--space-8);
}

.feature {
  text-align: center;
  padding: var(--space-6);
}

.feature-icon {
  font-size: 0.9rem;
  font-weight: 600;
  color: var(--secondary);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  display: block;
  margin-bottom: var(--space-4);
}

.feature h3 {
  color: var(--secondary-dark);
  margin-bottom: 0.5rem;
}

.feature p {
  color: var(--text-light);
  font-size: var(--text-body);
}

/* Example Section */
.example-section {
  background: var(--bg-secondary);
  padding: var(--card-padding);
  border-radius: var(--radius);
  text-align: center;
}

/* Aurora Studios Specific Styles */
.section-subtitle {
  font-size: var(--text-subtitle);
  color: var(--text-light);
  margin-bottom: var(--section-spacing);
  text-align: center;
  max-width: 600px;
  margin-left: auto;
  margin-right: auto;
}

/* What We Do section title */
#services h2 {
  text-align: center;
}

.service-icon {
  font-size: var(--text-small);
  font-weight: 600;
  color: var(--primary);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  margin-bottom: var(--space-6);
  display: block;
}

/* Featured Work Section */
.featured-work {
  padding: var(--section-spacing) 0;
  background: var(--bg-secondary);
}

.featured-work h2 {
  font-size: var(--heading-h2);
  text-align: center;
  margin-bottom: var(--section-spacing);
  color: var(--text);
}

.work-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
  gap: var(--space-6);
  max-width: 1200px;
  margin: 0 auto;
  padding: 0 var(--space-8);
}

.work-item {
  background: white;
  border-radius: var(--radius);
  overflow: hidden;
  box-shadow: var(--shadow);
  transition: transform 0.3s ease;
}

.work-item:hover {
  transform: translateY(-5px);
}

.section-cta {
  text-align: center;
  margin-top: var(--space-8);
  padding-top: var(--space-6);
  border-top: 1px solid var(--border);
}

.featured-work-cta {
  text-align: center;
  margin-top: var(--space-8);
}

.work-image {
  width: 100%;
  height: 250px;
  object-fit: cover;
}

.work-info {
  padding: var(--space-6);
}

.work-info h3 {
  color: var(--primary);
  margin-bottom: var(--space-2);
}

.work-info p {
  color: var(--text-light);
  font-size: var(--text-body);
}

/* CTA Section */
.cta-section {
  background: linear-gradient(135deg, var(--secondary), var(--primary));
  color: white;
  padding: var(--section-spacing) var(--space-8);
  text-align: center;
  margin: var(--section-spacing) var(--space-4);
  border-radius: var(--radius);
}

.cta-content h2 {
  margin-bottom: var(--space-4);
  font-size: var(--heading-h2);
}

.cta-content p {
  font-size: var(--text-subtitle);
  opacity: 0.9;
  margin-bottom: var(--space-8);
  color: white;
}

.cta-section .btn {
  background: white;
  color: var(--text);
  font-weight: 600;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.cta-section .btn:hover {
  background: var(--bg-secondary);
  transform: translateY(-2px) scale(1.02);
  box-shadow: 0 6px 16px rgba(0, 0, 0, 0.15);
}

.cta-section .btn:focus {
  outline: none;
}

/* Page Header - Shared across sub-pages */
.page-header {
  text-align: center;
  margin-bottom: var(--section-spacing);
}

.page-header h1 {
  font-size: var(--heading-h1);
  margin-bottom: var(--space-4);
  color: var(--text);
}

.page-subtitle {
  font-size: var(--text-subtitle);
  color: var(--text-light);
  max-width: 600px;
  margin: 0 auto;
}

/* Section Header Component */
.section-header {
  text-align: center;
  margin-bottom: var(--section-spacing);
}

.section-header h2 {
  font-size: var(--heading-h2);
  color: var(--text);
  margin-bottom: var(--space-3);
  position: relative;
}

.section-header h2::after {
  content: '';
  position: absolute;
  bottom: -0.75rem;
  left: 50%;
  transform: translateX(-50%);
  width: 2rem;
  height: 3px;
  background: var(--primary);
  border-radius: 2px;
}

.section-header .section-subtitle {
  font-size: var(--text-subtitle);
  color: var(--text-light);
  margin-top: var(--space-6);
  margin-bottom: 0;
  max-width: 600px;
  margin-left: auto;
  margin-right: auto;
  line-height: 1.6;
}

/* Content Sections - Shared layout styles */
.content-section {
  margin-bottom: var(--section-spacing);
}

.content-section h2 {
  font-size: var(--heading-h2);
  color: var(--text);
  margin-bottom: var(--space-4);
  position: relative;
}

.content-section p {
  font-size: var(--text-subtitle);
  line-height: 1.8;
  color: var(--text-light);
  margin-bottom: var(--space-6);
  text-align: center;
}

/* Team Grid - Shared component */
.team-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
  gap: var(--space-6);
  margin-top: var(--space-8);
}

.team-member {
  text-align: center;
  padding: var(--card-padding);
  background: var(--bg-secondary);
  border-radius: var(--radius);
  transition: transform 0.3s ease, box-shadow 0.3s ease;
}

.team-member:hover {
  transform: translateY(-5px);
  box-shadow: var(--shadow);
}

.team-member img {
  width: 100px;
  height: 100px;
  border-radius: 50%;
  object-fit: cover;
  margin-bottom: var(--space-4);
  border: 3px solid var(--primary);
}

.team-member h3 {
  font-size: var(--heading-h3);
  color: var(--text);
  margin-bottom: var(--space-2);
}

.team-member .role {
  color: var(--primary);
  font-weight: 600;
  margin-bottom: var(--space-4);
}

.team-member p {
  font-size: var(--text-small);
  color: var(--text-light);
  line-height: 1.6;
}

/* Contact Page Components */
.contact-card .contact-detail {
  font-weight: 600;
  color: var(--primary);
  font-size: var(--text-base);
  margin: var(--space-4) 0;
  padding: var(--space-3);
  background: var(--bg-secondary);
  border-radius: var(--space-2);
  text-align: center;
}

.contact-form-section {
  max-width: 600px;
  margin: 0 auto;
  background: white;
  padding: var(--card-padding);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
}

.social-proof-container {
  max-width: 800px;
  margin: 0 auto;
  text-align: center;
}

/* Tablet Responsive Styles */
@media (min-width: 768px) and (max-width: 1023px) {
  /* Hero adjustments for tablet */
  .hero.sub-page {
    height: calc(50vh + var(--navbar-height));
    min-height: calc(350px + var(--navbar-height));
  }
  
  /* Grid layout adjustments for tablet */
  .card-grid,
  .work-grid,
  .team-grid,
  .portfolio-grid {
    grid-template-columns: repeat(2, 1fr);
    gap: var(--space-6);
  }
  
}

/* Mobile Responsive Styles */
@media (max-width: 767px) {
  :root {
    /* Mobile-optimized typography */
    --heading-h1: var(--text-3xl);
    --heading-h2: var(--text-2xl);
    --heading-h3: var(--text-lg);
    --text-subtitle: var(--text-base);
    
    /* Tighter spacing for mobile */
    --section-spacing: var(--space-10);
    --card-padding: var(--space-4);
  }
  
  /* Hero section mobile adjustments */
  .hero {
    margin: 0rem var(--space-4) var(--section-spacing);
    padding: var(--space-6) var(--space-4);
  }
  
  .hero h1 {
    font-size: var(--text-4xl);
  }
  
  .hero.sub-page {
    height: calc(40vh + var(--navbar-height));
    min-height: calc(250px + var(--navbar-height));
  }
  
  /* Grid layout adjustments - single column for mobile */
  .card-grid,
  .work-grid,
  .team-grid,
  .portfolio-grid {
    grid-template-columns: 1fr;
    gap: var(--space-4);
  }
  
  
  /* Mobile button improvements */
  .btn {
    width: 100%;
    max-width: 280px;
    text-align: center;
  }
  
  .hero-buttons {
    flex-direction: column;
    align-items: center;
    gap: var(--space-3);
  }
  
  /* Mobile typography improvements */
  p {
    margin-bottom: var(--space-6);
  }
  
  /* Contact form mobile adjustments */
  .form-row {
    grid-template-columns: 1fr;
    gap: var(--space-4);
    margin-bottom: var(--space-4);
  }
  
  .social-proof-stats {
    grid-template-columns: 1fr;
    gap: var(--space-6);
  }
  
  .social-proof-text {
    margin-left: 0;
    border-left: none;
    border-top: 3px solid var(--primary);
    padding-left: 0;
    padding-top: var(--space-4);
  }
}

.contact-info h2 {
  font-size: var(--heading-h2);
  color: var(--text);
  margin-bottom: var(--space-4);
}

.contact-info p {
  font-size: var(--text-subtitle);
  line-height: 1.8;
  color: var(--text-light);
  margin-bottom: var(--space-8);
}


/* Contact Form - Refactored */
.contact-form-container {
  padding: var(--card-padding);
}

.contact-form-container .section-header {
  text-align: left;
  margin-bottom: var(--space-8);
}

.contact-form-container .section-header h2 {
  font-size: var(--heading-h2);
  color: var(--text);
  margin-bottom: var(--space-3);
}

.contact-form-container .section-header p {
  color: var(--text-light);
  font-size: var(--text-base);
  margin: 0;
}

.form-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-4);
  margin-bottom: var(--space-6);
}

.form-group {
  margin-bottom: var(--space-6);
}

.form-group label {
  display: block;
  font-weight: 600;
  color: var(--text);
  font-size: var(--text-body);
  margin-bottom: var(--space-2);
}

.form-group input,
.form-group select,
.form-group textarea {
  width: 100%;
  padding: var(--space-4);
  border: 2px solid var(--border);
  border-radius: var(--radius);
  font-size: var(--text-body);
  transition: border-color 0.3s ease, box-shadow 0.3s ease;
}

.form-group input:focus,
.form-group select:focus,
.form-group textarea:focus {
  outline: none;
  border-color: var(--primary);
  box-shadow: 0 0 0 3px rgba(234, 88, 12, 0.1);
}

.form-group textarea {
  resize: vertical;
  min-height: 120px;
}

.checkbox-group {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
}

.checkbox-group input[type="checkbox"] {
  width: auto;
  margin: 0;
  transform: scale(1.2);
}

.checkbox-group label {
  margin-bottom: 0;
  font-weight: normal;
  font-size: var(--text-small);
  cursor: pointer;
}

.error-message {
  color: #ef4444;
  font-size: var(--text-sm);
  margin-top: var(--space-1);
  display: block;
}

.btn-full {
  width: 100%;
  padding: var(--space-4) var(--space-8);
  font-size: var(--text-subtitle);
  font-weight: 600;
}

.form-success {
  display: none;
  background: #10b981;
  color: white;
  padding: var(--space-6);
  border-radius: var(--radius);
  margin-top: var(--space-4);
  text-align: center;
  border: 1px solid #059669;
}

.form-success.show {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
}

.form-success .success-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: rgba(255, 255, 255, 0.2);
  border-radius: 50%;
  flex-shrink: 0;
}

.form-success .success-icon svg {
  width: 20px;
  height: 20px;
  stroke: white;
  stroke-width: 3;
}

.form-success p {
  margin: 0;
  font-weight: 500;
  font-size: var(--text-body);
}

/* Social Proof Section */
.contact-social-proof {
  background: var(--bg-secondary);
  padding: var(--card-padding);
  border-radius: var(--radius);
  border: 2px solid var(--border);
}

.contact-social-proof h3 {
  font-size: var(--heading-h3);
  color: var(--text);
  margin-bottom: var(--space-6);
  text-align: center;
}

.social-proof-stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-4);
  margin-bottom: var(--space-6);
}

.stat {
  text-align: center;
  padding: var(--space-3);
}

.stat-number {
  font-size: var(--text-2xl);
  font-weight: 700;
  color: var(--primary);
  margin-bottom: var(--space-1);
}

.stat-label {
  font-size: var(--text-sm);
  color: var(--text-light);
  font-weight: 500;
}

.social-proof-text {
  font-style: italic;
  color: var(--text);
  line-height: 1.6;
  margin-bottom: var(--space-4);
  text-align: center;
  border-left: 3px solid var(--primary);
  padding-left: var(--space-4);
  margin-left: var(--space-4);
}

.social-proof-attribution {
  text-align: center;
  color: var(--text-light);
  font-size: var(--text-sm);
}

.testimonial {
  margin-top: var(--space-8);
  padding: var(--space-6);
  background: var(--bg-secondary);
  border-radius: var(--radius);
  border-left: 4px solid var(--primary);
}

.testimonial-text {
  font-size: var(--text-lg);
  font-style: italic;
  color: var(--text);
  line-height: 1.6;
  margin-bottom: var(--space-4);
}

.testimonial-attribution {
  color: var(--text-light);
  font-size: var(--text-sm);
}

/* Loading state for form submission */
.contact-form.loading .btn-primary {
  background: var(--neutral);
  cursor: not-allowed;
  position: relative;
}

.contact-form.loading .btn-primary:after {
  content: '';
  position: absolute;
  width: 20px;
  height: 20px;
  margin: auto;
  border: 2px solid white;
  border-top: 2px solid transparent;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

/* Form validation styles */
.form-group.error input,
.form-group.error select,
.form-group.error textarea {
  border-color: #ef4444;
  background-color: #fef2f2;
}

.form-group.success input,
.form-group.success select,
.form-group.success textarea {
  border-color: #10b981;
  background-color: #f0fdf4;
}

/* Footer - Modern Light Design */
.site-footer {
  background: var(--bg-secondary);
  border-top: 1px solid var(--border);
  padding: var(--section-spacing) 0 0;
  margin-top: var(--section-spacing);
}

.footer-content {
  max-width: 1200px;
  margin: 0 auto;
  padding: 0 var(--space-8) var(--section-spacing);
  display: grid;
  grid-template-columns: 1fr 2fr;
  gap: var(--space-10);
  align-items: start;
}

/* Footer Brand Section */
.footer-brand {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.footer-logo {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  font-size: var(--text-xl);
  font-weight: 600;
  color: var(--text);
}

.footer-logo img {
  width: 40px;
  height: 40px;
}

.footer-tagline {
  color: var(--text-light);
  font-size: var(--text-body);
  margin: 0;
  line-height: 1.5;
}

.footer-social {
  display: flex;
  gap: var(--space-3);
  margin-top: var(--space-2);
}

.footer-social a {
  width: 36px;
  height: 36px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: white;
  color: var(--text);
  text-decoration: none;
  font-size: var(--text-base);
  transition: all 0.2s ease;
  border: 1px solid var(--border);
}

.footer-social a:hover {
  background: var(--primary);
  color: white;
  border-color: var(--primary);
  transform: translateY(-2px);
}

/* Footer Links Section */
.footer-links-section {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-8);
}

.footer-column h4 {
  font-size: var(--text-base);
  font-weight: 600;
  color: var(--text);
  margin-bottom: var(--space-4);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.footer-links {
  list-style: none;
  padding: 0;
  margin: 0;
}

.footer-links li {
  margin-bottom: var(--space-3);
}

.footer-links a {
  color: var(--text-light);
  text-decoration: none;
  font-size: var(--text-body);
  transition: color 0.2s ease;
  position: relative;
}

.footer-links a:hover {
  color: var(--primary);
  transform: translateX(2px);
  display: inline-block;
}

/* Footer Bottom Bar */
.footer-bottom {
  border-top: 1px solid var(--border);
  padding: var(--space-6) var(--space-8);
  max-width: 1200px;
  margin: 0 auto;
  display: flex;
  justify-content: space-between;
  align-items: center;
  flex-wrap: wrap;
  gap: var(--space-4);
}

.footer-hf-link {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  color: var(--text-light);
  text-decoration: none;
  font-size: var(--text-sm);
  font-weight: 500;
  transition: all 0.2s ease;
  padding: var(--space-1) var(--space-2);
  border-radius: var(--space-1);
}

.footer-hf-link:hover {
  color: var(--primary);
  background: rgba(234, 88, 12, 0.1);
  transform: translateY(-1px);
}

.footer-hf-link svg {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}

.footer-bottom-links {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}

.footer-bottom-links a {
  color: var(--text-light);
  text-decoration: none;
  font-size: var(--text-sm);
  transition: color 0.2s ease;
}

.footer-bottom-links a:hover {
  color: var(--primary);
}

.footer-bottom-links .separator {
  color: var(--text-light);
  font-size: var(--text-sm);
}

/* Responsive Footer Styles */
@media (max-width: 767px) {
  .footer-content {
    grid-template-columns: 1fr;
    gap: var(--space-8);
    padding: 0 var(--space-4) var(--space-8);
  }
  
  .footer-brand {
    text-align: center;
    align-items: center;
  }
  
  .footer-links-section {
    grid-template-columns: 1fr 1fr;
    gap: var(--space-6);
    text-align: center;
  }
  
  .footer-column h4 {
    text-align: center;
  }
  
  .footer-links {
    text-align: center;
  }
  
  .footer-links a {
    display: inline-block;
  }
  
  .footer-bottom {
    flex-direction: column;
    text-align: center;
    padding: var(--space-4);
  }
  
  .footer-bottom-links {
    flex-wrap: wrap;
    justify-content: center;
  }
}

`
    },
    {
      path: '/styles/portfolio.css',
      content: `/* Portfolio Page Styles */

/* Portfolio Filters */
.portfolio-filters {
  display: flex;
  justify-content: center;
  gap: var(--space-4);
  margin-bottom: var(--section-spacing);
  flex-wrap: wrap;
}

.filter-btn {
  padding: var(--space-3) var(--space-6);
  border: 2px solid var(--border);
  background: transparent;
  border-radius: 50px;
  cursor: pointer;
  transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  font-weight: 500;
  font-size: var(--text-body);
  color: var(--text-light);
  box-shadow: 0 2px 4px rgba(0, 0, 0, 0.05);
}

.filter-btn:hover,
.filter-btn.active {
  border-color: var(--primary);
  background: var(--primary);
  color: white;
  transform: translateY(-1px) scale(1.01);
  box-shadow: 0 4px 12px rgba(234, 88, 12, 0.2);
}

.filter-btn:focus {
  outline: none;
}

.filter-btn:active {
  transform: translateY(0) scale(0.99);
}

/* Portfolio Grid */
.portfolio-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(350px, 1fr));
  gap: var(--space-6);
  margin-bottom: var(--section-spacing);
}

.portfolio-item {
  position: relative;
  border-radius: var(--radius);
  overflow: hidden;
  box-shadow: var(--shadow);
  transition: transform 0.3s ease;
  cursor: pointer;
}

.portfolio-item:hover {
  transform: translateY(-10px);
}

.portfolio-item.hidden {
  display: none;
}

.portfolio-image {
  width: 100%;
  height: 300px;
  object-fit: cover;
  transition: transform 0.3s ease;
}

.portfolio-item:hover .portfolio-image {
  transform: scale(1.05);
}

.portfolio-overlay {
  position: absolute;
  bottom: 0;
  left: 0;
  right: 0;
  background: linear-gradient(transparent, rgba(0,0,0,0.8));
  color: white;
  padding: var(--card-padding);
  transform: translateY(100%);
  transition: transform 0.3s ease;
}

.portfolio-item:hover .portfolio-overlay {
  transform: translateY(0);
}

.portfolio-overlay h3 {
  font-size: var(--heading-h3);
  margin-bottom: var(--space-2);
}

.portfolio-overlay p {
  margin-bottom: var(--space-4);
  opacity: 0.9;
  color: white;
}

.portfolio-tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.tag {
  background: rgba(255,255,255,0.2);
  color: white;
  padding: var(--space-1) var(--space-3);
  border-radius: 20px;
  font-size: var(--text-xs);
  font-weight: 500;
}`
    },
    {
      path: '/scripts/main.js',
      content: `// Main JavaScript - Shared functionality

// Multi-file demo loaded

// Set up navigation highlighting
document.addEventListener('DOMContentLoaded', function() {
    const currentPath = window.location.pathname;
    const navLinks = document.querySelectorAll('.nav-link');
    
    navLinks.forEach(link => {
        if (link.getAttribute('href') === currentPath) {
            link.classList.add('active');
        } else {
            link.classList.remove('active');
        }
    });
    
    // Scroll-reactive navbar functionality
    const navbar = document.querySelector('.navbar');
    const hero = document.querySelector('.hero');
    let lastScrollY = window.scrollY;
    let heroHeight = hero ? hero.offsetHeight : 0;
    
    function updateNavbarVisibility() {
        const currentScrollY = window.scrollY;
        const scrollDifference = currentScrollY - lastScrollY;
        
        // Always show navbar in hero section
        if (currentScrollY <= heroHeight) {
            navbar.classList.remove('hidden');
        } 
        // Hide when scrolling down past hero section
        else if (scrollDifference > 0) {
            navbar.classList.add('hidden');
        }
        // Show when scrolling up by 20px or more
        else if (scrollDifference <= -20) {
            navbar.classList.remove('hidden');
        }
        
        lastScrollY = currentScrollY;
    }
    
    // Throttle scroll events for better performance
    let ticking = false;
    function handleScroll() {
        if (!ticking) {
            requestAnimationFrame(updateNavbarVisibility);
            ticking = true;
            setTimeout(() => { ticking = false; }, 16); // ~60fps
        }
    }
    
    window.addEventListener('scroll', handleScroll);
    
    // Recalculate hero height on resize
    window.addEventListener('resize', function() {
        heroHeight = hero ? hero.offsetHeight : 0;
    });
    
    // Mobile hamburger menu functionality
    const navToggle = document.querySelector('.nav-toggle');
    const navMenu = document.querySelector('.nav-menu');
    const mobileNavLinks = document.querySelectorAll('.nav-link');
    
    function toggleMobileMenu() {
        navToggle.classList.toggle('active');
        navMenu.classList.toggle('active');
        navbar.classList.toggle('menu-open');
        
        // Update ARIA attributes
        const isExpanded = navToggle.classList.contains('active');
        navToggle.setAttribute('aria-expanded', isExpanded);
        
        // Prevent body scroll when menu is open
        document.body.style.overflow = isExpanded ? 'hidden' : '';
    }
    
    function closeMobileMenu() {
        navToggle.classList.remove('active');
        navMenu.classList.remove('active');
        navbar.classList.remove('menu-open');
        navToggle.setAttribute('aria-expanded', 'false');
        document.body.style.overflow = '';
    }
    
    // Toggle menu on button click
    if (navToggle) {
        navToggle.addEventListener('click', toggleMobileMenu);
    }
    
    // Close menu when clicking nav links
    mobileNavLinks.forEach(link => {
        link.addEventListener('click', closeMobileMenu);
    });
    
    // Close menu on escape key
    document.addEventListener('keydown', function(e) {
        if (e.key === 'Escape' && navMenu.classList.contains('active')) {
            closeMobileMenu();
        }
    });
    
    // Close menu when clicking outside
    document.addEventListener('click', function(e) {
        if (!navToggle.contains(e.target) && !navMenu.contains(e.target) && navMenu.classList.contains('active')) {
            closeMobileMenu();
        }
    });
    
    // Close mobile menu when navbar hides (scroll reactive)
    const originalUpdateNavbarVisibility = updateNavbarVisibility;
    updateNavbarVisibility = function() {
        originalUpdateNavbarVisibility();
        if (navbar.classList.contains('hidden') && navMenu.classList.contains('active')) {
            closeMobileMenu();
        }
    };
    
});`
    },
    {
      path: '/templates/navigation.hbs',
      content: `<nav class="navbar">
    <a href="/" class="nav-brand">
        <img src="/assets/images/logo.svg" alt="{{siteName}}" class="nav-logo">
        <span>{{siteName}}</span>
    </a>
    
    <button class="nav-toggle" aria-label="Toggle navigation menu" aria-expanded="false">
        <span class="hamburger-line"></span>
        <span class="hamburger-line"></span>
        <span class="hamburger-line"></span>
    </button>
    
    <ul class="nav-menu">
        {{#each navigation}}
        <li><a href="{{url}}" class="nav-link">{{title}}</a></li>
        {{/each}}
    </ul>
</nav>`
    },
    {
      path: '/templates/footer.hbs',
      content: `<footer class="site-footer">
    <div class="footer-content">
        <div class="footer-brand">
            <div class="footer-logo">
                <img src="/assets/images/logo.svg" alt="{{siteName}}" width="40" height="40">
                <span>{{siteName}}</span>
            </div>
            <p class="footer-tagline">{{footerTagline}}</p>
            <div class="footer-social">
                {{#each social}}
                <a href="{{url}}" aria-label="{{name}}">{{icon}}</a>
                {{/each}}
            </div>
        </div>
        
        <div class="footer-links-section">
            <div class="footer-column">
                <h4>Explore</h4>
                <ul class="footer-links">
                    {{#each navigation}}
                    <li><a href="{{url}}">{{title}}</a></li>
                    {{/each}}
                </ul>
            </div>
            
            <div class="footer-column">
                <h4>Services</h4>
                <ul class="footer-links">
                    {{#each services}}
                    <li><a href="{{url}}">{{name}}</a></li>
                    {{/each}}
                </ul>
            </div>
        </div>
    </div>
    
    <div class="footer-bottom">
        <a href="{{deepstudioLink}}" target="_blank" class="footer-hf-link">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" xmlns="http://www.w3.org/2000/svg">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z"/>
            </svg>
            <span>{{deepstudioName}}</span>
        </a>
        <div class="footer-bottom-links">
            {{#each legalLinks}}
            <a href="{{url}}">{{name}}</a>
            {{#unless @last}}<span class="separator">•</span>{{/unless}}
            {{/each}}
        </div>
    </div>
</footer>`
    },
    {
      path: '/scripts/portfolio.js',
      content: `// Portfolio Filtering Functionality

(function() {
    let currentFilter = 'all';
    
    function init() {
        const filterButtons = document.querySelectorAll('.filter-btn');
        const portfolioItems = document.querySelectorAll('.portfolio-item');
        
        if (!filterButtons.length || !portfolioItems.length) return;
        
        // Add event listeners to filter buttons
        filterButtons.forEach(btn => {
            btn.addEventListener('click', handleFilterClick);
        });
        
        // Show all items initially
        showItems(portfolioItems, 'all');
    }
    
    function handleFilterClick(e) {
        const button = e.target;
        const filter = button.dataset.filter;
        
        if (!filter) return;
        
        // Update active button
        document.querySelectorAll('.filter-btn').forEach(btn => {
            btn.classList.remove('active');
        });
        button.classList.add('active');
        
        // Filter and show items
        const portfolioItems = document.querySelectorAll('.portfolio-item');
        showItems(portfolioItems, filter);
        
        currentFilter = filter;
    }
    
    function showItems(items, filter) {
        items.forEach(item => {
            const itemCategory = item.dataset.category;
            
            if (filter === 'all' || itemCategory === filter) {
                item.style.display = 'block';
                item.style.opacity = '0';
                
                // Animate in
                setTimeout(() => {
                    item.style.opacity = '1';
                    item.style.transform = 'translateY(0)';
                }, 50);
            } else {
                item.style.opacity = '0';
                item.style.transform = 'translateY(20px)';
                
                // Hide after animation
                setTimeout(() => {
                    item.style.display = 'none';
                }, 300);
            }
        });
    }
    
    // Add smooth transitions to portfolio items
    function addTransitions() {
        const portfolioItems = document.querySelectorAll('.portfolio-item');
        portfolioItems.forEach(item => {
            item.style.transition = 'opacity 0.3s ease, transform 0.3s ease';
        });
    }
    
    document.addEventListener('DOMContentLoaded', function() {
        addTransitions();
        init();
    });
})();`
    },
    {
      path: '/scripts/contact.js',
      content: `// Contact Form Validation and Submission

(function() {
    let form;
    let submitButton;
    let isSubmitting = false;
    
    function init() {
        form = document.getElementById('contactForm');
        submitButton = form?.querySelector('button[type="submit"]');
        
        if (!form || !submitButton) return;
        
        // Add event listeners
        form.addEventListener('submit', handleSubmit);
        
        // Real-time validation
        const inputs = form.querySelectorAll('input[required], textarea[required]');
        inputs.forEach(input => {
            input.addEventListener('blur', validateField);
            input.addEventListener('input', clearErrors);
        });
        
        // Email specific validation
        const emailInput = form.querySelector('#email');
        if (emailInput) {
            emailInput.addEventListener('blur', validateEmail);
        }
    }
    
    function handleSubmit(e) {
        e.preventDefault();
        
        if (isSubmitting) return;
        
        // Clear all previous errors
        clearAllErrors();
        
        // Validate all fields
        const isValid = validateForm();
        
        if (isValid) {
            submitForm();
        }
    }
    
    function validateForm() {
        let isValid = true;
        
        // Required field validation
        const requiredFields = [
            { id: 'name', name: 'Full Name' },
            { id: 'email', name: 'Email Address' },
            { id: 'message', name: 'Project Details' }
        ];
        
        requiredFields.forEach(field => {
            const input = document.getElementById(field.id);
            const value = input.value.trim();
            
            if (!value) {
                showError(field.id, \`\${field.name} is required\`);
                isValid = false;
            }
        });
        
        // Email format validation
        const emailInput = document.getElementById('email');
        const emailValue = emailInput.value.trim();
        if (emailValue && !isValidEmail(emailValue)) {
            showError('email', 'Please enter a valid email address');
            isValid = false;
        }
        
        // Message length validation
        const messageInput = document.getElementById('message');
        const messageValue = messageInput.value.trim();
        if (messageValue && messageValue.length < 20) {
            showError('message', 'Please provide more details about your project (minimum 20 characters)');
            isValid = false;
        }
        
        return isValid;
    }
    
    function validateField(e) {
        const field = e.target;
        const value = field.value.trim();
        
        clearErrors(e);
        
        if (field.hasAttribute('required') && !value) {
            const fieldName = field.previousElementSibling.textContent.replace(' *', '');
            showError(field.id, \`\${fieldName} is required\`);
        }
    }
    
    function validateEmail(e) {
        const emailInput = e.target;
        const emailValue = emailInput.value.trim();
        
        if (emailValue && !isValidEmail(emailValue)) {
            showError('email', 'Please enter a valid email address');
        }
    }
    
    function isValidEmail(email) {
        const emailRegex = /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/;
        return emailRegex.test(email);
    }
    
    function showError(fieldId, message) {
        const field = document.getElementById(fieldId);
        const formGroup = field.parentElement;
        const errorElement = document.getElementById(fieldId + 'Error');
        
        // Add error class to form group
        formGroup.classList.add('error');
        formGroup.classList.remove('success');
        
        // Show error message
        if (errorElement) {
            errorElement.textContent = message;
        }
    }
    
    function clearErrors(e) {
        const field = e.target;
        const formGroup = field.parentElement;
        const errorElement = document.getElementById(field.id + 'Error');
        
        // Remove error class
        formGroup.classList.remove('error');
        
        // Clear error message
        if (errorElement) {
            errorElement.textContent = '';
        }
        
        // Add success class if field has value and no errors
        if (field.value.trim() && !formGroup.classList.contains('error')) {
            formGroup.classList.add('success');
        } else {
            formGroup.classList.remove('success');
        }
    }
    
    function clearAllErrors() {
        const errorMessages = form.querySelectorAll('.error-message');
        errorMessages.forEach(error => error.textContent = '');
        
        const formGroups = form.querySelectorAll('.form-group');
        formGroups.forEach(group => {
            group.classList.remove('error', 'success');
        });
        
        // Hide success message
        const successElement = document.getElementById('formSuccess');
        if (successElement) {
            successElement.classList.remove('show');
        }
    }
    
    function submitForm() {
        if (isSubmitting) return;
        
        isSubmitting = true;
        
        // Add loading state
        form.classList.add('loading');
        submitButton.disabled = true;
        submitButton.textContent = 'Sending...';
        
        // Collect form data
        const formData = new FormData(form);
        const data = {
            name: formData.get('name'),
            email: formData.get('email'),
            company: formData.get('company'),
            project: formData.get('project'),
            budget: formData.get('budget'),
            message: formData.get('message'),
            newsletter: formData.get('newsletter') ? true : false,
            timestamp: new Date().toISOString()
        };
        
        // Simulate form submission (replace with actual API call)
        setTimeout(() => {
            
            // Show success message
            showSuccess();
            
            // Reset form
            form.reset();
            clearAllErrors();
            
            // Remove loading state
            form.classList.remove('loading');
            submitButton.disabled = false;
            submitButton.textContent = 'Send Message';
            
            isSubmitting = false;
            
            // Auto-hide success message after 5 seconds
            setTimeout(() => {
                const successElement = document.getElementById('formSuccess');
                if (successElement) {
                    successElement.classList.remove('show');
                }
            }, 5000);
            
        }, 2000); // Simulate network delay
    }
    
    function showSuccess() {
        const successElement = document.getElementById('formSuccess');
        if (successElement) {
            successElement.classList.add('show');
            successElement.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
        }
    }
    
    // Initialize when DOM is ready
    document.addEventListener('DOMContentLoaded', init);
})();`
    },
    {
      path: '/data.json',
      content: `{
  "siteName": "Example Studios",
  "footerTagline": "Crafting digital experiences that inspire",
  "navigation": [
    {"title": "Home", "url": "/"},
    {"title": "Portfolio", "url": "/portfolio.html"},
    {"title": "About", "url": "/about.html"},
    {"title": "Contact", "url": "/contact.html"}
  ],
  "social": [
    {"name": "Twitter", "url": "#", "icon": "𝕏"},
    {"name": "LinkedIn", "url": "#", "icon": "in"},
    {"name": "Instagram", "url": "#", "icon": "📷"},
    {"name": "GitHub", "url": "#", "icon": "⚡"}
  ],
  "services": [
    {"name": "Web Design", "url": "/portfolio.html"},
    {"name": "Development", "url": "/portfolio.html"},
    {"name": "Mobile Apps", "url": "/portfolio.html"},
    {"name": "Consulting", "url": "/portfolio.html"}
  ],
  "deepstudioLink": "https://try.oswstudio.com",
  "deepstudioName": "OSW Studio",
  "legalLinks": [
    {"name": "Privacy Policy", "url": "/privacy.html"},
    {"name": "Terms of Service", "url": "/terms.html"}
  ]
}`
    },
    {
      path: '/assets/images/logo.svg',
      content: `<svg width="32" height="32" viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
  <defs>
    <linearGradient id="gradient" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" style="stop-color:#2563eb;stop-opacity:1" />
      <stop offset="100%" style="stop-color:#ff7b00;stop-opacity:1" />
    </linearGradient>
  </defs>
  <rect x="2" y="2" width="12" height="12" rx="2" fill="url(#gradient)" opacity="0.9"/>
  <rect x="18" y="2" width="12" height="12" rx="2" fill="#ff7b00" opacity="0.8"/>
  <rect x="2" y="18" width="12" height="12" rx="2" fill="#2563eb" opacity="0.8"/>
  <rect x="18" y="18" width="12" height="12" rx="2" fill="url(#gradient)" opacity="0.7"/>
  <circle cx="16" cy="16" r="6" fill="white" opacity="0.9"/>
  <circle cx="16" cy="16" r="3" fill="#1a365d"/>
</svg>`
    },
    {
      path: '/assets/images/favicon.svg',
      content: `<svg width="16" height="16" viewBox="0 0 16 16" xmlns="http://www.w3.org/2000/svg">
  <rect x="1" y="1" width="6" height="6" rx="1" fill="#2563eb"/>
  <rect x="9" y="1" width="6" height="6" rx="1" fill="#ff7b00"/>
  <rect x="1" y="9" width="6" height="6" rx="1" fill="#ff7b00"/>
  <rect x="9" y="9" width="6" height="6" rx="1" fill="#2563eb"/>
</svg>`
    },
    {
      path: '/contact.html',
      content: `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Contact - Example Studios</title>
    <link rel="icon" type="image/svg+xml" href="/assets/images/favicon.svg">
    <link rel="stylesheet" href="/styles/main.css">
</head>
<body>
    <nav class="navbar">
        <a href="/" class="nav-brand">
            <img src="/assets/images/logo.svg" alt="Example Studios" class="nav-logo">
            <span>Example Studios</span>
        </a>
        
        <button class="nav-toggle" aria-label="Toggle navigation menu" aria-expanded="false">
            <span class="hamburger-line"></span>
            <span class="hamburger-line"></span>
            <span class="hamburger-line"></span>
        </button>
        
        <ul class="nav-menu">
            <li><a href="/" class="nav-link">Home</a></li>
            <li><a href="/portfolio.html" class="nav-link">Portfolio</a></li>
            <li><a href="/about.html" class="nav-link">About</a></li>
            <li><a href="/contact.html" class="nav-link active">Contact</a></li>
        </ul>
    </nav>

    <main>
        <section class="hero sub-page">
            <div class="hero-content">
                <h1>Let's Build Something Amazing</h1>
                <p class="hero-subtitle">Ready to turn your ideas into reality? We'd love to hear about your project and show you how we can help.</p>
            </div>
        </section>
        
        <div class="container">
            <div class="section-header">
                <h2>Get In Touch</h2>
                <p class="section-subtitle">Ready to start your next project? Choose how you'd like to connect with us</p>
            </div>
            
            <div class="card-grid">
                <div class="card contact-card">
                    <div class="service-icon">Email</div>
                    <h3>Send Us an Email</h3>
                    <p>Drop us a line and we'll get back to you within 24 hours</p>
                    <div class="contact-detail">hello@examplestudios.com</div>
                    <a href="mailto:hello@examplestudios.com" class="btn">Send Email</a>
                </div>
                
                <div class="card contact-card">
                    <div class="service-icon">Phone</div>
                    <h3>Give Us a Call</h3>
                    <p>Speak directly with our team about your project</p>
                    <div class="contact-detail">(555) 123-4567</div>
                    <a href="tel:+15551234567" class="btn">Call Now</a>
                </div>
                
                <div class="card contact-card">
                    <div class="service-icon">Office</div>
                    <h3>Visit Our Studio</h3>
                    <p>Meet with us in person to discuss your vision</p>
                    <div class="contact-detail">San Francisco, CA<br><small>By appointment only</small></div>
                    <a href="/contact.html" class="btn">Schedule Visit</a>
                </div>
            </div>
        </div>
        
        <div class="container">
            <div class="section-header">
                <h2>Start Your Project</h2>
                <p class="section-subtitle">Tell us about your vision and we'll get back to you within 24 hours</p>
            </div>
            
            <div class="contact-form-section">
                <form class="contact-form" id="contactForm">
                    <div class="form-row">
                        <div class="form-group">
                            <label for="name">Your Name</label>
                            <input type="text" id="name" name="name" required>
                            <span class="error-message" id="nameError"></span>
                        </div>
                        
                        <div class="form-group">
                            <label for="email">Email Address</label>
                            <input type="email" id="email" name="email" required>
                            <span class="error-message" id="emailError"></span>
                        </div>
                    </div>
                    
                    <div class="form-group">
                        <label for="message">Tell us about your project</label>
                        <textarea id="message" name="message" rows="5" required placeholder="What are you looking to build? Share your goals, timeline, or any specific requirements..."></textarea>
                        <span class="error-message" id="messageError"></span>
                    </div>
                    
                    <button type="submit" class="btn btn-primary btn-full">Send Message</button>
                    
                    <div class="form-success" id="formSuccess">
                        <div class="success-icon">
                            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <path d="M16.667 5L7.5 14.167L3.333 10" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
                            </svg>
                        </div>
                        <p>Thank you! We'll get back to you within 24 hours.</p>
                    </div>
                </form>
            </div>
        </div>
        
        <section class="featured-work">
            <div class="section-header">
                <h2>Trusted by Growing Companies</h2>
                <p class="section-subtitle">Join the businesses that have transformed their digital presence with us</p>
            </div>
            
            <div class="social-proof-container">
                <div class="social-proof-stats">
                    <div class="stat">
                        <div class="stat-number">50+</div>
                        <div class="stat-label">Projects Completed</div>
                    </div>
                    <div class="stat">
                        <div class="stat-number">24hr</div>
                        <div class="stat-label">Response Time</div>
                    </div>
                    <div class="stat">
                        <div class="stat-number">100%</div>
                        <div class="stat-label">Client Satisfaction</div>
                    </div>
                </div>
                
                <div class="testimonial">
                    <p class="testimonial-text">"Example Studios delivered our project on time and exceeded our expectations. Their attention to detail is remarkable and their team was incredibly responsive throughout the entire process."</p>
                    <div class="testimonial-attribution">
                        <strong>Sarah Chen</strong>, Product Manager at TechCorp
                    </div>
                </div>
            </div>
        </section>
    </main>

    {{> footer}}

    <script src="/scripts/main.js"></script>
    <script src="/scripts/contact.js"></script>
</body>
</html>`
    },
    {
      path: '/privacy.html',
      content: `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Privacy Policy - Example Studios</title>
    <link rel="icon" type="image/svg+xml" href="/assets/images/favicon.svg">
    <link rel="stylesheet" href="/styles/main.css">
</head>
<body>
    {{> navigation}}

    <main>
        <section class="hero sub-page">
            <div class="hero-content">
                <h1>Privacy Policy</h1>
                <p class="hero-subtitle">How we protect and handle your information</p>
            </div>
        </section>
        
        <div class="container">
            <div class="content-section">
                <p><strong>Last updated:</strong> December 2024</p>
                
                <h2>Overview</h2>
                <p>At Example Studios, we take your privacy seriously. This Privacy Policy explains how we collect, use, and protect your personal information when you use our services.</p>
                
                <h2>Information We Collect</h2>
                <p>We may collect the following types of information:</p>
                <ul>
                    <li><strong>Contact Information:</strong> Name, email address, phone number when you contact us</li>
                    <li><strong>Project Information:</strong> Details about your project requirements and preferences</li>
                    <li><strong>Usage Data:</strong> How you interact with our website for improving our services</li>
                </ul>
                
                <h2>How We Use Your Information</h2>
                <p>We use your information to:</p>
                <ul>
                    <li>Provide and improve our design and development services</li>
                    <li>Communicate with you about your projects</li>
                    <li>Send you updates about our services (with your consent)</li>
                    <li>Analyze and improve our website and services</li>
                </ul>
                
                <h2>Information Sharing</h2>
                <p>We do not sell, trade, or otherwise transfer your personal information to third parties without your consent, except:</p>
                <ul>
                    <li>To trusted service providers who help us operate our business</li>
                    <li>When required by law or to protect our rights</li>
                    <li>With your explicit consent</li>
                </ul>
                
                <h2>Data Security</h2>
                <p>We implement appropriate security measures to protect your personal information against unauthorized access, alteration, disclosure, or destruction.</p>
                
                <h2>Your Rights</h2>
                <p>You have the right to:</p>
                <ul>
                    <li>Access and review your personal information</li>
                    <li>Request corrections to your information</li>
                    <li>Request deletion of your information</li>
                    <li>Opt-out of marketing communications</li>
                </ul>
                
                <h2>Contact Us</h2>
                <p>If you have questions about this Privacy Policy, please contact us at:</p>
                <p>
                    <strong>Example Studios</strong><br>
                    Email: hello@examplestudios.com<br>
                    Phone: (555) 123-4567
                </p>
            </div>
        </div>
        
        <section class="cta-section">
            <div class="cta-content">
                <h2>Ready to Build Something Amazing?</h2>
                <p>Let's turn your ideas into reality. We'd love to hear about your project.</p>
                <a href="/contact.html" class="btn btn-primary">Start Your Project</a>
            </div>
        </section>
    </main>

    {{> footer}}

    <script src="/scripts/main.js"></script>
</body>
</html>`
    },
    {
      path: '/terms.html',
      content: `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Terms of Service - Example Studios</title>
    <link rel="icon" type="image/svg+xml" href="/assets/images/favicon.svg">
    <link rel="stylesheet" href="/styles/main.css">
</head>
<body>
    {{> navigation}}

    <main>
        <section class="hero sub-page">
            <div class="hero-content">
                <h1>Terms of Service</h1>
                <p class="hero-subtitle">Our terms and conditions for working together</p>
            </div>
        </section>
        
        <div class="container">
            <div class="content-section">
                <p><strong>Last updated:</strong> December 2024</p>
                
                <h2>Agreement to Terms</h2>
                <p>By accessing and using Example Studios' services, you agree to be bound by these Terms of Service and all applicable laws and regulations.</p>
                
                <h2>Services</h2>
                <p>Example Studios provides web design, development, and digital consulting services. We reserve the right to modify or discontinue services with reasonable notice.</p>
                
                <h2>Client Responsibilities</h2>
                <p>As a client, you agree to:</p>
                <ul>
                    <li>Provide accurate and complete information for your project</li>
                    <li>Respond to requests for feedback in a timely manner</li>
                    <li>Collaborate effectively throughout the project</li>
                    <li>Respect intellectual property rights</li>
                </ul>
                
                <h2>Project Process</h2>
                <p>Our typical process includes:</p>
                <ul>
                    <li><strong>Discovery:</strong> Understanding your requirements and goals</li>
                    <li><strong>Proposal:</strong> Detailed scope, timeline, and pricing</li>
                    <li><strong>Design & Development:</strong> Creating your solution</li>
                    <li><strong>Review:</strong> Client feedback and revisions</li>
                    <li><strong>Launch:</strong> Final delivery and launch support</li>
                </ul>
                
                <h2>Project Timeline</h2>
                <ul>
                    <li>Project schedules will be outlined in individual agreements</li>
                    <li>Milestone deliverables will be clearly defined</li>
                    <li>Regular progress updates will be provided</li>
                </ul>
                
                <h2>Intellectual Property</h2>
                <p>Upon project completion, clients receive ownership of custom work created specifically for their project, excluding any pre-existing intellectual property or third-party components.</p>
                
                <h2>Limitation of Liability</h2>
                <p>Example Studios' liability is limited to the amount paid for services. We are not responsible for indirect, incidental, or consequential damages.</p>
                
                <h2>Termination</h2>
                <p>Either party may terminate services with written notice. All completed work will be delivered upon termination.</p>
                
                <h2>Changes to Terms</h2>
                <p>We reserve the right to update these terms with reasonable notice to existing clients.</p>
                
                <h2>Contact</h2>
                <p>Questions about these terms? Contact us at:</p>
                <p>
                    <strong>Example Studios</strong><br>
                    Email: hello@examplestudios.com<br>
                    Phone: (555) 123-4567
                </p>
            </div>
        </div>
    </main>

    {{> footer}}

    <script src="/scripts/main.js"></script>
</body>
</html>`
    },
    {
      path: '/portfolio/techflow-dashboard.html',
      content: `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>TechFlow Dashboard - Example Studios</title>
    <link rel="icon" type="image/svg+xml" href="/assets/images/favicon.svg">
    <link rel="stylesheet" href="/styles/main.css">
</head>
<body>
    <nav class="navbar">
        <a href="/" class="nav-brand">
            <img src="/assets/images/logo.svg" alt="Example Studios" class="nav-logo">
            <span>Example Studios</span>
        </a>
        
        <button class="nav-toggle" aria-label="Toggle navigation menu" aria-expanded="false">
            <span class="hamburger-line"></span>
            <span class="hamburger-line"></span>
            <span class="hamburger-line"></span>
        </button>
        
        <ul class="nav-menu">
            <li><a href="/" class="nav-link">Home</a></li>
            <li><a href="/portfolio.html" class="nav-link active">Portfolio</a></li>
            <li><a href="/about.html" class="nav-link">About</a></li>
            <li><a href="/contact.html" class="nav-link">Contact</a></li>
        </ul>
    </nav>

    <main>
        <section class="hero sub-page">
            <div class="hero-content">
                <h1>TechFlow Dashboard</h1>
                <p class="hero-subtitle">Modern analytics platform with real-time data visualization</p>
            </div>
        </section>
        
        <div class="container">
            <section class="content-section">
                <div class="section-header">
                    <h2>Project Overview</h2>
                    <p class="section-subtitle">A comprehensive analytics solution built for modern businesses</p>
                </div>
                
                <div class="card-grid">
                    <div class="card">
                        <div class="service-icon">Challenge</div>
                        <h3>Challenge</h3>
                        <p>TechFlow needed a modern dashboard to visualize complex data streams in real-time, replacing their outdated reporting system with something more intuitive and scalable.</p>
                    </div>
                    
                    <div class="card">
                        <div class="service-icon">Solution</div>
                        <h3>Solution</h3>
                        <p>We designed and built a React-based dashboard with D3.js visualizations, featuring customizable widgets and real-time data updates via WebSocket connections.</p>
                    </div>
                </div>
            </section>
            
            <section class="content-section">
                <div class="section-header">
                    <h2>Technology Stack</h2>
                </div>
                <div class="card-grid">
                    <div class="card">
                        <div class="service-icon">React</div>
                        <h3>React</h3>
                        <p>Modern component-based architecture for maintainable UI development</p>
                    </div>
                    
                    <div class="card">
                        <div class="service-icon">Data</div>
                        <h3>D3.js</h3>
                        <p>Custom data visualizations with smooth animations and interactions</p>
                    </div>
                    
                    <div class="card">
                        <div class="service-icon">Backend</div>
                        <h3>Node.js</h3>
                        <p>Robust backend API with real-time data processing capabilities</p>
                    </div>
                </div>
            </section>
            
            <section class="content-section">
                <div class="section-header">
                    <h2>Results</h2>
                </div>
                <div class="card">
                    <div class="service-icon">Results</div>
                    <h3>Impact & Performance</h3>
                    <p>The new dashboard reduced report generation time by 75% and improved user engagement by 300%. Real-time updates eliminated the need for manual refreshes, and the intuitive interface reduced training time for new users.</p>
                </div>
            </section>
        </div>
        
        <section class="cta-section">
            <div class="cta-content">
                <h2>Ready for Your Next Project?</h2>
                <p>Let's discuss how we can create a custom solution for your business needs.</p>
                <a href="/contact.html" class="btn btn-primary">Start Your Project</a>
            </div>
        </section>
    </main>

    {{> footer}}

    <script src="/scripts/main.js"></script>
</body>
</html>`
    },
    {
      path: '/assets/README.md',
      content: `# Assets Directory

This directory contains all static assets for the Example project.

## Structure

- \`/images/\` - Image files including:
  - \`example-background.jpg\` - Hero section background image
  - \`logo.svg\` - Site logo
  - \`favicon.svg\` - Browser favicon

## Background Image

The \`example-background.jpg\` is automatically included when the demo project is created. It features a beautiful flowing gradient design that complements the orange (#ff7b00) and blue (#2563eb) color scheme.

## File Types Supported

The VFS system supports various file types:
- Images: PNG, JPG, JPEG, GIF, WebP, SVG, ICO
- Documents: HTML, CSS, JS, JSON, TXT, MD, XML
- Binary files up to 10MB

This demonstrates the VFS capability to handle multiple file types and organize them in a structured directory system.`
    },
    {
      path: '/.PROMPT.md',
      content: HANDLEBARS_DOMAIN_PROMPT
    }
  ],
  assets: [
    { filename: 'example-background.jpg', path: '/assets/images/example-background.jpg' }
  ]
};