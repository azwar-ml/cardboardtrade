import Header from "@/components/Header";
import Hero from "@/components/Hero";
import ProductMarquee from "@/components/ProductMarquee";
import ModernTouch from "@/components/ModernTouch";
import Comparison from "@/components/Comparison";
import BuyerSeller from "@/components/BuyerSeller";
import Products from "@/components/Products";
import SmartMatching from "@/components/SmartMatching";
import ExportMap from "@/components/ExportMap";
import Faq from "@/components/Faq";
import ContactForm from "@/components/ContactForm";
import Footer from "@/components/Footer";

export default function Home() {
  return (
    <>
      <Header />
      <main id="main">
        <Hero />
        <ProductMarquee />
        <ModernTouch />
        <Comparison />
        <BuyerSeller />
        <Products />
        <SmartMatching />
        <ExportMap />
        <Faq />
        <ContactForm />
      </main>
      <Footer />
    </>
  );
}
